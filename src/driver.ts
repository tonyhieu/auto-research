// Autonomous research driver: a loop that launches ./bin/research and ./bin/preprint for one
// topic, reads each run's outcome, and records decisions. The decider is injectable: a
// heuristic (phase 1) or the LLM analyst (phase 2).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeAnalyst, makeSelector, type Selector } from "./analyst.ts";
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
	type Portfolio,
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
import { archiveBrief, nextQueuedBrief, QUEUE_DIR } from "./queue.ts";
import { validateBrief } from "./brief.ts";
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

// --- Portfolio (roaming) loop: a selector picks the topic or a new one; the per-topic analyst picks the action. ---

interface PortfolioOpts {
	root: string;
	runner: Runner;
	cfg: DriverConfig;
	select: Selector;
	decide: Decider;
	/** Topics root; injectable so tests do not touch the repo's topics/. */
	topicsRoot?: string;
	/** Human brief queue dir; injectable for tests. */
	queueDir?: string;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

/** Seed a topic from a validated brief and run its first breadth window. */
async function startTopicFromBrief(p: Portfolio, topic: TopicPaths, brief: string, area: string, runner: Runner, cfg: DriverConfig): Promise<number> {
	writeFileSync(topic.brief, brief.endsWith("\n") ? brief : `${brief}\n`);
	const rec = topicRecord(p, topic.slug, topic.title, area);
	const code = await runner.research(["-t", topic.title, "-n", String(cfg.windows)]);
	finishRun(p, rec, { kind: "breadth", windows: cfg.windows }, [], topic, code, cfg);
	return code;
}

/** Add any topics/<slug>/ not yet in the portfolio, so existing work is visible to the selector. */
function seedExistingTopics(p: Portfolio, cfg: DriverConfig, dir: string): void {
	if (!existsSync(dir)) return;
	for (const slug of readdirSync(dir)) {
		const meta = join(dir, slug, "topic.json");
		if (p.topics.some((t) => t.slug === slug) || !existsSync(meta)) continue;
		try {
			const title = JSON.parse(readFileSync(meta, "utf8")).title ?? slug;
			topicRecord(p, slug, title, cfg.area);
		} catch {
			// skip an unreadable topic.json
		}
	}
}

function summarize(p: Portfolio, topicsRoot: string): string {
	if (!p.topics.length) return "(empty portfolio; propose a first topic)";
	return p.topics
		.map((t) => {
			const f = loadFindings(ensureTopic(t.title, topicsRoot));
			const vn = verifiedNovelIds(f).length;
			return `- ${t.slug} [area ${t.area}, ${t.status}] runs=${t.runs} findings=${f.length} verified-novel=${vn} deepened=${t.deepened.length} preprinted=${t.preprinted.length}`;
		})
		.join("\n");
}

export async function runPortfolio(opts: PortfolioOpts): Promise<void> {
	const { root, runner, cfg, select, decide } = opts;
	const topicsRoot = opts.topicsRoot ?? join(REPO_ROOT, "topics");
	const queueDir = opts.queueDir ?? QUEUE_DIR;
	const sleep = opts.sleep ?? sleepMs;
	const log = opts.log ?? ((l: string) => console.log(l));
	const now = () => new Date().toISOString();
	const started = now();
	clearStop(root);
	const status = (label: string | null, lastDecision?: Decision, running = true) =>
		writeStatus(root, { running, pid: process.pid, startedAt: started, heartbeatAt: now(), currentAction: null, label: label ?? undefined, lastDecision });
	status(null);

	let cycle = 0;
	let last: Decision | undefined;
	while (!stopRequested(root)) {
		if (cfg.maxCycles !== undefined && cycle >= cfg.maxCycles) break;
		cycle++;
		const p = readPortfolio(root);
		seedExistingTopics(p, cfg, topicsRoot);
		writePortfolio(root, p);
		const existing = p.topics.map((t) => ({ slug: t.slug, title: t.title }));

		// Human briefs take priority over the selector.
		const queued = nextQueuedBrief(queueDir);
		if (queued) {
			const entry: Decision = { ts: now(), rationale: `human brief from queue: ${queued.title}`, select: { kind: "new-topic", title: queued.title, area: cfg.area, brief: "" } };
			const v = validateBrief(queued.title, queued.brief, existing);
			if (!v.ok) {
				archiveBrief(queued.file, "rejected", v.error);
				log(`[queue] rejected ${queued.title}: ${v.error}`);
				appendDecision(root, { ...entry, outcome: { reason: `rejected: ${v.error}`, exitCode: 0 } });
				last = entry;
				continue;
			}
			const topic = ensureTopic(queued.title, topicsRoot);
			status(`queue new-topic ${topic.slug}`, last);
			log(`[queue] starting ${topic.slug}`);
			const code = await startTopicFromBrief(p, topic, v.brief, cfg.area, runner, cfg);
			writePortfolio(root, p);
			archiveBrief(queued.file, "done");
			entry.slug = topic.slug;
			entry.action = { kind: "breadth", windows: cfg.windows };
			entry.outcome = outcomeOf(p.topics.find((t) => t.slug === topic.slug)!, topic, code);
			appendDecision(root, entry);
			last = entry;
			status(null, entry);
			continue;
		}

		const { decision, rationale: why } = await select({ summary: summarize(p, topicsRoot), existing, cfg });
		status(`${decision.kind}${decision.kind === "work" ? ` ${decision.slug}` : ""}`, last);
		log(`[director] ${decision.kind}: ${why}`);
		const entry: Decision = { ts: now(), rationale: why, select: decision };

		if (decision.kind === "stop") {
			appendDecision(root, { ...entry, outcome: { reason: "stopped", exitCode: 0 } });
			last = entry;
			break;
		}
		if (decision.kind === "idle") {
			appendDecision(root, entry);
			last = entry;
			await sleep(decision.minutes * 60_000);
			continue;
		}
		if (decision.kind === "new-topic") {
			const topic = ensureTopic(decision.title, topicsRoot);
			const code = await startTopicFromBrief(p, topic, decision.brief, decision.area, runner, cfg);
			writePortfolio(root, p);
			entry.slug = topic.slug;
			entry.action = { kind: "breadth", windows: cfg.windows };
			entry.outcome = outcomeOf(p.topics.find((t) => t.slug === topic.slug)!, topic, code);
			appendDecision(root, entry);
			last = entry;
			status(null, entry);
			continue;
		}
		// work: delegate the exact action to the per-topic analyst.
		const rec = p.topics.find((t) => t.slug === decision.slug)!;
		const topic = ensureTopic(rec.title, topicsRoot);
		const { action, rationale: why2 } = await decide({ findings: loadFindings(topic), rec, cfg, topic });
		entry.slug = topic.slug;
		entry.action = action;
		entry.rationale = `${why}; ${why2}`;
		log(`[analyst] ${action.kind}: ${why2}`);
		if (action.kind === "retire") {
			rec.status = "retired";
			writePortfolio(root, p);
			appendDecision(root, { ...entry, outcome: { reason: "retired", exitCode: 0 } });
			last = entry;
			status(null, entry);
			continue;
		}
		if (action.kind === "idle" || action.kind === "stop") {
			appendDecision(root, entry);
			last = entry;
			if (action.kind === "idle") await sleep(action.minutes * 60_000);
			else break;
			continue;
		}
		const vnBefore = verifiedNovelIds(loadFindings(topic));
		const code = await execute(action, topic, runner, cfg.brief);
		finishRun(p, rec, action, vnBefore, topic, code, cfg);
		writePortfolio(root, p);
		entry.outcome = outcomeOf(rec, topic, code);
		appendDecision(root, entry);
		last = entry;
		status(null, entry);
	}
	status(null, last, false);
}

function finishRun(_p: Portfolio, rec: TopicRecord, action: Action, vnBefore: string[], topic: TopicPaths, code: number, cfg: DriverConfig): void {
	const after = loadFindings(topic);
	const end = lastRunEnd(topic.runs);
	const reason = action.kind === "preprint" ? (code === 0 ? "complete" : "error") : (end?.reason ?? (code === 0 ? "complete" : "error"));
	applyOutcome(rec, { action, vnBefore, vnAfter: verifiedNovelIds(after), reason, ts: new Date().toISOString() }, cfg);
}

function outcomeOf(rec: TopicRecord, topic: TopicPaths, code: number): Decision["outcome"] {
	const after = loadFindings(topic);
	return { reason: rec.lastReason ?? (code === 0 ? "complete" : "error"), exitCode: code, findings: after.length, verifiedNovel: rec.verifiedNovel };
}

// Entry point: driver -t "Topic" [-b brief.md] [-a area] [--heuristic]  |  driver (roam across the portfolio)
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
	const log = (l: string) => console.log(l);
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
	// No -t: roam the whole portfolio (the autonomous default).
	if (!values.topic) {
		const models = await ModelRuntime.create();
		await runPortfolio({ root: PORTFOLIO_DIR, runner: defaultRunner, cfg: DEFAULT_CONFIG, select: makeSelector(models, log), decide: makeAnalyst(models, log), log });
		process.exit(0);
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
	const decide = values.heuristic ? heuristicDecider : makeAnalyst(await ModelRuntime.create(), log);
	await runDriver({ topic, root: PORTFOLIO_DIR, runner: defaultRunner, cfg, decide, log });
}
