// Autonomous research driver: a loop that launches ./bin/research and ./bin/preprint for one
// topic, reads each run's outcome, and records decisions. The decider is injectable: a
// heuristic (phase 1) or the LLM analyst (phase 2).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeAnalyst } from "./analyst.ts";
import { type Finding, loadFindings } from "./ledger.ts";
import {
	type Action,
	applyOutcome,
	appendDecision,
	clearStop,
	type Decision,
	DEFAULT_CONFIG,
	type DriverConfig,
	decideNext,
	lastRunEnd,
	PORTFOLIO_DIR,
	rationale,
	readPortfolio,
	stopRequested,
	type TopicRecord,
	topicRecord,
	verifiedNovelIds,
	writePortfolio,
	writeStatus,
} from "./portfolio.ts";
import { ensureTopic, REPO_ROOT, slugify, type TopicPaths } from "./topic.ts";

/** Launches the harness binaries; injectable so tests drive the loop without real runs. */
export interface Runner {
	research(args: string[]): Promise<number>;
	preprint(args: string[]): Promise<number>;
}

/** What a decider sees to choose the next action for a topic. */
export interface DecideContext {
	findings: Finding[];
	rec: TopicRecord;
	cfg: DriverConfig;
	topic: TopicPaths;
}
export type Decider = (ctx: DecideContext) => Promise<{ action: Action; rationale: string }>;

export const heuristicDecider: Decider = async ({ findings, rec, cfg }) => {
	const action = decideNext({ findings, rec, cfg });
	return { action, rationale: rationale(action, verifiedNovelIds(findings)) };
};

const spawnBin = (bin: string, args: string[]): Promise<number> =>
	new Promise((resolve) => {
		const child = spawn(join(REPO_ROOT, "bin", bin), args, { cwd: REPO_ROOT, stdio: "inherit" });
		child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
		child.on("error", () => resolve(1));
	});

export const defaultRunner: Runner = {
	research: (args) => spawnBin("research", args),
	preprint: (args) => spawnBin("preprint", args),
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface DriverOpts {
	topic: TopicPaths;
	root: string;
	runner: Runner;
	cfg: DriverConfig;
	decide?: Decider;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

function execute(action: Action, topic: TopicPaths, runner: Runner, brief?: string): Promise<number> {
	if (action.kind === "breadth") return runner.research(["-t", topic.title, "-n", String(action.windows), ...(brief ? ["-b", brief] : [])]);
	if (action.kind === "focus") return runner.research(["-t", topic.title, "-n", String(action.windows), "-f", action.findingId ?? action.hypothesis ?? ""]);
	if (action.kind === "preprint") return runner.preprint(["-t", topic.title, "-f", action.findingId]);
	throw new Error(`execute called with non-run action ${action.kind}`);
}

export async function runDriver(opts: DriverOpts): Promise<void> {
	const { topic, root, runner, cfg } = opts;
	const decide = opts.decide ?? heuristicDecider;
	const sleep = opts.sleep ?? sleepMs;
	const log = opts.log ?? ((l: string) => console.log(l));
	const now = () => new Date().toISOString();
	const started = now();
	// A leftover STOP from a previous `run-forever stop` would abort immediately; clear it on start.
	clearStop(root);
	const status = (currentAction: Action | null, lastDecision?: Decision, running = true) =>
		writeStatus(root, { running, pid: process.pid, startedAt: started, heartbeatAt: now(), currentAction, lastDecision });
	status(null);

	let cycle = 0;
	let last: Decision | undefined;
	while (!stopRequested(root)) {
		if (cfg.maxCycles !== undefined && cycle >= cfg.maxCycles) break;
		cycle++;
		const findings = loadFindings(topic);
		const p = readPortfolio(root);
		const rec = topicRecord(p, topic.slug, topic.title, cfg.area);
		const { action, rationale: why } = await decide({ findings, rec, cfg, topic });
		const decision: Decision = { ts: now(), action, rationale: why };
		status(action, last);
		log(`[driver] ${action.kind}: ${why}`);

		if (action.kind === "stop" || action.kind === "retire") {
			if (action.kind === "retire") {
				rec.status = "retired";
				writePortfolio(root, p);
			}
			appendDecision(root, { ...decision, outcome: { reason: action.kind === "retire" ? "retired" : "stopped", exitCode: 0 } });
			last = decision;
			break;
		}
		if (action.kind === "idle") {
			appendDecision(root, decision);
			last = decision;
			await sleep(action.minutes * 60_000);
			continue;
		}

		const vnBefore = verifiedNovelIds(findings);
		const code = await execute(action, topic, runner, cfg.brief);
		const after = loadFindings(topic);
		const end = lastRunEnd(topic.runs);
		const reason = action.kind === "preprint" ? (code === 0 ? "complete" : "error") : (end?.reason ?? (code === 0 ? "complete" : "error"));
		applyOutcome(rec, { action, vnBefore, vnAfter: verifiedNovelIds(after), reason, ts: now() }, cfg);
		writePortfolio(root, p);
		decision.outcome = { reason, exitCode: code, findings: after.length, verifiedNovel: rec.verifiedNovel };
		appendDecision(root, decision);
		last = decision;
		status(null, decision);
	}
	status(null, last, false);
}

// Entry point: driver -t "Topic" [-b brief.md] [-a area] [--heuristic]
if (import.meta.filename === process.argv[1] || process.argv[1]?.endsWith("driver.ts")) {
	const envFile = join(REPO_ROOT, ".env");
	if (existsSync(envFile)) process.loadEnvFile(envFile);
	const { values } = parseArgs({
		options: {
			topic: { type: "string", short: "t" },
			brief: { type: "string", short: "b" },
			area: { type: "string", short: "a" },
			heuristic: { type: "boolean", default: false },
		},
	});
	if (!values.topic) {
		console.error('usage: driver -t "Topic" [-b brief.md] [-a area] [--heuristic]');
		process.exit(2);
	}
	if (values.brief && !existsSync(values.brief)) {
		console.error(`brief not found: ${values.brief}`);
		process.exit(2);
	}
	// Do not create a brand-new topic by typo; it must exist unless a brief is supplied to seed it.
	if (!values.brief && !existsSync(join(REPO_ROOT, "topics", slugify(values.topic)))) {
		console.error(`no topic ${slugify(values.topic)}; pass -b brief.md to start a new one`);
		process.exit(2);
	}
	const topic = ensureTopic(values.topic);
	const cfg: DriverConfig = { ...DEFAULT_CONFIG, ...(values.area ? { area: values.area } : {}), ...(values.brief ? { brief: values.brief } : {}) };
	const log = (l: string) => console.log(l);
	const decide = values.heuristic ? heuristicDecider : makeAnalyst(await ModelRuntime.create(), log);
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
	await runDriver({ topic, root: PORTFOLIO_DIR, runner: defaultRunner, cfg, decide, log });
}
