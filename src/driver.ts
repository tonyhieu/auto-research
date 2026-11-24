// Autonomous research driver: a loop that launches ./bin/research and ./bin/preprint for one
// topic, reads each run's outcome, and records decisions. The decider is injectable: a
// heuristic (phase 1) or the LLM analyst (phase 2).
import { spawn, type StdioOptions } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { makeAnalyst, makeSelector, type Selector } from "./analyst.ts";
import { dockerUp, enforce, lockExists } from "./guardrails.ts";
import { type Finding, loadFindings } from "./ledger.ts";
import {
	type Action,
	actionOfStart,
	applyOutcome,
	appendDecision,
	clearStop,
	type Decision,
	DEFAULT_CONFIG,
	type DriverConfig,
	decideNext,
	endReason,
	type LaneStatus,
	type Portfolio,
	PORTFOLIO_DIR,
	rationale,
	readPortfolio,
	type RunEndRec,
	runEnds,
	runStarts,
	stopRequested,
	type TopicRecord,
	topicRecord,
	unaccountedRuns,
	updateRecord,
	verifiedNovelIds,
	writePortfolio,
	writeStatus,
} from "./portfolio.ts";
import { archiveBrief, claimBrief, nextQueuedBrief, QUEUE_DIR } from "./queue.ts";
import { validateBrief } from "./brief.ts";
import { ensureTopic, pidAlive, REPO_ROOT, slugify, type TopicPaths } from "./topic.ts";

/** Launches the harness binaries; injectable so tests drive the loop without real runs. `lane` is set by the roaming loop. */
export interface Runner {
	research(args: string[], lane?: number): Promise<number>;
	preprint(args: string[], lane?: number): Promise<number>;
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

/** A lane's child appends to portfolio/lanes/lane-<n>.out, so parallel runs do not interleave in one log. */
const spawnBin = (bin: string, args: string[], lane?: number): Promise<number> =>
	new Promise((resolve) => {
		let stdio: StdioOptions = "inherit";
		let fd: number | undefined;
		if (lane !== undefined) {
			const dir = join(PORTFOLIO_DIR, "lanes");
			mkdirSync(dir, { recursive: true });
			fd = openSync(join(dir, `lane-${lane}.out`), "a");
			stdio = ["ignore", fd, fd];
		}
		const child = spawn(join(REPO_ROOT, "bin", bin), args, { cwd: REPO_ROOT, stdio });
		if (fd !== undefined) closeSync(fd); // the child holds its own copy
		child.on("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
		child.on("error", () => resolve(1));
	});

export const defaultRunner: Runner = {
	research: (args, lane) => spawnBin("research", args, lane),
	preprint: (args, lane) => spawnBin("preprint", args, lane),
};

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sleep in one-minute slices so a STOP request does not wait out a long idle. */
async function nap(halted: () => boolean, sleep: (ms: number) => Promise<void>, ms: number): Promise<void> {
	for (let left = ms; left > 0 && !halted(); left -= 60_000) await sleep(Math.min(left, 60_000));
}

interface DriverOpts {
	topic: TopicPaths;
	root: string;
	runner: Runner;
	cfg: DriverConfig;
	decide?: Decider;
	sleep?: (ms: number) => Promise<void>;
	log?: (line: string) => void;
}

function execute(action: Action, topic: TopicPaths, runner: Runner, cfg: DriverConfig, brief?: string, lane?: number): Promise<number> {
	const base = ["-t", topic.title, "-n", String("windows" in action ? action.windows : 1), "-c", String(cfg.concurrency)];
	if (action.kind === "breadth") return runner.research([...base, ...(brief ? ["-b", brief] : [])], lane);
	if (action.kind === "focus") return runner.research([...base, "-f", action.findingId ?? action.hypothesis ?? ""], lane);
	if (action.kind === "preprint") return runner.preprint(["-t", topic.title, "-f", action.findingId], lane);
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
	const status = (action: Action | null, lastDecision?: Decision, running = true) =>
		writeStatus(root, {
			running,
			pid: process.pid,
			startedAt: started,
			heartbeatAt: now(),
			lanes: action ? [{ lane: 1, label: `${action.kind} ${topic.slug}`, slug: topic.slug, action, since: now() }] : [],
			external: [],
			lastDecision,
		});
	const halted = () => stopRequested(root);
	status(null);

	let cycle = 0;
	let last: Decision | undefined;
	while (!stopRequested(root)) {
		if (cfg.maxCycles !== undefined && cycle >= cfg.maxCycles) break;
		cycle++;
		const findings = loadFindings(topic);
		const p = readPortfolio(root);
		const rec = topicRecord(p, topic.slug, topic.title, cfg.area);
		const { action: raw, rationale: why } = await decide({ findings, rec, cfg, topic });
		const g = enforce(raw, rec, cfg, { locked: lockExists(topic), docker: raw.kind === "focus" ? dockerUp() : true });
		const action = g.action;
		const decision: Decision = { ts: now(), action, rationale: g.note ? `${why} [${g.note}]` : why };
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
			await nap(halted, sleep, action.minutes * 60_000);
			continue;
		}

		const vnBefore = verifiedNovelIds(findings);
		const mark = runMark(topic);
		const code = await execute(action, topic, runner, cfg, cfg.brief);
		const reason = finishRun(rec, action, vnBefore, mark, topic, code, cfg);
		writePortfolio(root, p);
		decision.outcome = outcomeOf(rec, topic, code, reason);
		appendDecision(root, decision);
		last = decision;
		status(null, decision);
		if (rec.status === "retired") break;
		// Back off after a failed run so a deterministic failure does not spin.
		if (reason !== "complete") await nap(halted, sleep, cfg.idleMinutes * 60_000);
	}
	status(null, last, false);
}

// --- Portfolio (roaming) loop: a selector picks the topic or a new one; the per-topic analyst picks the action. ---
// Lanes run that cycle independently: deciding happens under a mutex, only the harness run is parallel.

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
	/** Pool tick (heartbeat, external locks, reconcile); real timer, injectable for tests. */
	tickMs?: number;
}

/** A promise-chain mutex: `run` calls execute one at a time, in call order. */
class Mutex {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const r = this.tail.then(fn);
		this.tail = r.catch(() => {});
		return r;
	}
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

function summarize(p: Portfolio, topicsRoot: string, busyNote: (slug: string) => string | undefined = () => undefined): string {
	if (!p.topics.length) return "(empty portfolio; propose a first topic)";
	return p.topics
		.map((t) => {
			const f = loadFindings(ensureTopic(t.title, topicsRoot));
			const vn = verifiedNovelIds(f).length;
			const busy = busyNote(t.slug);
			return `- ${t.slug} [area ${t.area}, ${t.status}] runs=${t.runs} findings=${f.length} verified-novel=${vn} deepened=${t.deepened.length} preprinted=${t.preprinted.length}${busy ? ` (busy: ${busy})` : ""}`;
		})
		.join("\n");
}

const actionNote = (a: Action | undefined): string =>
	a?.kind === "focus" ? `focus ${a.findingId ?? "hypothesis"}` : a?.kind === "preprint" ? `preprint ${a.findingId}` : (a?.kind ?? "planning");

/** Pid of the live process holding <dir>/.lock, else undefined. */
function lockPid(dir: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(dir, ".lock"), "utf8"));
		return pid > 0 && pidAlive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Locked topics no lane owns: manual, UI, or orphaned runs. */
function externalLocks(topicsRoot: string, busy: Map<string, number>): { slug: string; pid: number }[] {
	if (!existsSync(topicsRoot)) return [];
	const out: { slug: string; pid: number }[] = [];
	for (const slug of readdirSync(topicsRoot)) {
		const pid = busy.has(slug) ? undefined : lockPid(join(topicsRoot, slug));
		if (pid) out.push({ slug, pid });
	}
	return out;
}

/** Apply outcomes of finished runs this driver did not see end (manual, UI, or pre-restart runs). */
function reconcile(root: string, topicsRoot: string, cfg: DriverConfig, log: (l: string) => void, busy: Map<string, number>): void {
	for (const t of readPortfolio(root).topics) {
		if (busy.has(t.slug)) continue; // a lane records its own run
		const topic = ensureTopic(t.title, topicsRoot);
		if (lockExists(topic)) continue; // still running; reconcile when it ends
		// Bootstrap: with no marker at all, pre-driver history is not counted.
		if (!t.lastRunId && !t.lastRunAt) {
			const latest = runEnds(topic.runs).at(-1);
			if (latest) updateRecord(root, t.slug, (r) => void (r.lastRunId = latest.runId));
			continue;
		}
		for (const { start, end } of unaccountedRuns(topic.runs, t)) {
			const reason = endReason(end);
			const vnAfter = verifiedNovelIds(loadFindings(topic));
			const action = actionOfStart(start);
			const rec = updateRecord(root, t.slug, (r) => {
				applyOutcome(r, { action, vnBefore: [], vnAfter, gained: vnAfter.length > r.verifiedNovel, reason, ts: end.ts }, cfg);
				r.lastRunId = end.runId;
			});
			appendDecision(root, {
				ts: end.ts,
				rationale: "run finished outside this driver",
				slug: t.slug,
				action,
				reconciled: true,
				outcome: { reason, exitCode: end.exitCode, findings: end.findings, verifiedNovel: rec?.verifiedNovel },
			});
			log(`[reconcile] ${t.slug} ${start.runId} ${action.kind} ${reason}`);
		}
	}
}

/** What a lane's planning step settled on; `next` means a decision was recorded and the lane can cycle again. */
type Plan =
	| { kind: "stop" }
	| { kind: "idle"; minutes: number }
	| { kind: "next" }
	| { kind: "run"; action: Action; topic: TopicPaths; entry: Decision; vnBefore: string[]; mark: RunMark; brief?: string; briefFile?: string };

export async function runPortfolio(opts: PortfolioOpts): Promise<void> {
	const { root, runner, cfg, select, decide } = opts;
	const topicsRoot = opts.topicsRoot ?? join(REPO_ROOT, "topics");
	const queueDir = opts.queueDir ?? QUEUE_DIR;
	const sleep = opts.sleep ?? sleepMs;
	const log = opts.log ?? ((l: string) => console.log(l));
	const tickMs = opts.tickMs ?? 60_000;
	const now = () => new Date().toISOString();
	const started = now();
	clearStop(root);

	const lanes = new Map<number, Promise<void>>();
	const busy = new Map<string, number>(); // slug -> lane
	const laneStatus = new Map<number, LaneStatus>();
	const mutex = new Mutex();
	let external: { slug: string; pid: number }[] = [];
	let stopping = false;
	let cyclesUsed = 0;
	let last: Decision | undefined;
	const halted = () => stopping || stopRequested(root);

	const status = (running = true) =>
		writeStatus(root, {
			running,
			pid: process.pid,
			startedAt: started,
			heartbeatAt: now(),
			lanes: running ? [...laneStatus.values()].sort((a, b) => a.lane - b.lane) : [],
			external: running ? external : [],
			lastDecision: last,
		});
	const setLane = (n: number, label?: string, slug?: string, action?: Action) => {
		if (label === undefined) laneStatus.delete(n);
		else laneStatus.set(n, { lane: n, label, slug, action, since: now() });
		status();
	};
	const record = (d: Decision) => {
		appendDecision(root, d);
		last = d;
	};

	/** Write the brief and add the record in one synchronous step, so dedup in another lane sees it. */
	const seedTopic = (topic: TopicPaths, brief: string, area: string, stampNewTopic: boolean) => {
		writeFileSync(topic.brief, brief.endsWith("\n") ? brief : `${brief}\n`);
		const p = readPortfolio(root);
		topicRecord(p, topic.slug, topic.title, area);
		// Cooldown counts from creation, not from the end of the (hours-long) first run.
		if (stampNewTopic) p.lastNewTopicAt = now();
		writePortfolio(root, p);
	};
	const claimRun = (n: number, topic: TopicPaths, action: Action, entry: Decision, brief?: string, briefFile?: string): Plan => {
		busy.set(topic.slug, n);
		entry.slug = topic.slug;
		entry.action = action;
		setLane(n, `${action.kind} ${topic.slug}`, topic.slug, action);
		return { kind: "run", action, topic, entry, vnBefore: verifiedNovelIds(loadFindings(topic)), mark: runMark(topic), brief, briefFile };
	};

	/** Select + analyst + claims; runs under the mutex, so it sees every other lane's claims. */
	async function planCycle(n: number): Promise<Plan> {
		const llog = (l: string) => log(`[lane ${n}] ${l}`);
		setLane(n, "select");
		const p = readPortfolio(root);
		seedExistingTopics(p, cfg, topicsRoot);
		writePortfolio(root, p);
		const ext = externalLocks(topicsRoot, busy);
		const busyNote = (slug: string): string | undefined => {
			const l = busy.get(slug);
			if (l !== undefined) return `lane ${l}, ${actionNote(laneStatus.get(l)?.action)}`;
			return ext.some((e) => e.slug === slug) ? "external run" : undefined;
		};
		const existing = p.topics.map((t) => ({ slug: t.slug, title: t.title, area: t.area, status: t.status, busy: busyNote(t.slug) !== undefined }));

		// Human briefs take priority over the selector.
		const queued = nextQueuedBrief(queueDir);
		if (queued) {
			const entry: Decision = { ts: now(), lane: n, rationale: `human brief from queue: ${queued.title}`, select: { kind: "new-topic", title: queued.title, area: cfg.area, brief: "" } };
			const v = validateBrief(queued.title, queued.brief, existing);
			if (!v.ok) {
				archiveBrief(queued.file, "rejected", v.error);
				llog(`[queue] rejected ${queued.title}: ${v.error}`);
				record({ ...entry, outcome: { reason: `rejected: ${v.error}`, exitCode: 0 } });
				return { kind: "next" };
			}
			// Claimed before the mutex is released, so no other lane can take it.
			const briefFile = claimBrief(queued.file);
			const topic = ensureTopic(queued.title, topicsRoot);
			seedTopic(topic, v.brief, cfg.area, false);
			llog(`[queue] starting ${topic.slug}`);
			return claimRun(n, topic, { kind: "breadth", windows: cfg.windows }, entry, undefined, briefFile);
		}

		const { decision, rationale: why } = await select({ summary: summarize(p, topicsRoot, busyNote), existing, cfg });
		llog(`[director] ${decision.kind}: ${why}`);
		const entry: Decision = { ts: now(), lane: n, rationale: why, select: decision };

		if (decision.kind === "stop") {
			record({ ...entry, outcome: { reason: "stopped", exitCode: 0 } });
			return { kind: "stop" };
		}
		if (decision.kind === "idle") {
			record(entry);
			return { kind: "idle", minutes: decision.minutes };
		}
		if (decision.kind === "new-topic") {
			const lastNew = readPortfolio(root).lastNewTopicAt;
			const since = lastNew ? Date.now() - Date.parse(lastNew) : Number.POSITIVE_INFINITY;
			if (since < cfg.newTopicCooldownHours * 3_600_000) {
				llog(`[director] new-topic on cooldown (${cfg.newTopicCooldownHours}h); idling`);
				record({ ...entry, outcome: { reason: "cooldown", exitCode: 0 } });
				return { kind: "idle", minutes: cfg.idleMinutes };
			}
			const topic = ensureTopic(decision.title, topicsRoot);
			seedTopic(topic, decision.brief, decision.area, true);
			return claimRun(n, topic, { kind: "breadth", windows: cfg.windows }, entry);
		}
		// work: refuse a topic another lane or an external run already holds.
		const held = busyNote(decision.slug);
		if (held) {
			llog(`[director] ${decision.slug} is already running (${held}); idling`);
			record({ ...entry, slug: decision.slug, outcome: { reason: "busy", exitCode: 0 } });
			return { kind: "idle", minutes: cfg.idleMinutes };
		}
		const rec = readPortfolio(root).topics.find((t) => t.slug === decision.slug);
		if (!rec) throw new Error(`work on unknown topic ${decision.slug}`);
		const topic = ensureTopic(rec.title, topicsRoot);
		// Delegate the exact action to the per-topic analyst.
		const { action: raw, rationale: why2 } = await decide({ findings: loadFindings(topic), rec, cfg, topic });
		const g = enforce(raw, rec, cfg, { locked: lockExists(topic), docker: raw.kind === "focus" ? dockerUp() : true });
		const action = g.action;
		entry.slug = topic.slug;
		entry.action = action;
		entry.rationale = `${why}; ${why2}${g.note ? ` [${g.note}]` : ""}`;
		llog(`[analyst] ${action.kind}: ${why2}`);
		if (action.kind === "retire") {
			updateRecord(root, topic.slug, (r) => void (r.status = "retired"));
			record({ ...entry, outcome: { reason: "retired", exitCode: 0 } });
			return { kind: "next" };
		}
		if (action.kind === "idle" || action.kind === "stop") {
			record(entry);
			return action.kind === "idle" ? { kind: "idle", minutes: action.minutes } : { kind: "stop" };
		}
		return claimRun(n, topic, action, entry, cfg.brief);
	}

	/** Fold a finished run into the portfolio with no await in between, so lanes cannot overwrite each other. */
	function recordRun(plan: Extract<Plan, { kind: "run" }>, code: number): string {
		let reason = "error";
		const rec = updateRecord(root, plan.topic.slug, (r) => {
			reason = finishRun(r, plan.action, plan.vnBefore, plan.mark, plan.topic, code, cfg);
		});
		if (plan.briefFile) archiveBrief(plan.briefFile, "done");
		plan.entry.outcome = outcomeOf(rec, plan.topic, code, reason);
		record(plan.entry);
		return reason;
	}

	/** One cycle; catches everything so a failing lane never takes the others down. */
	async function runLane(n: number): Promise<void> {
		cyclesUsed++;
		try {
			const plan = await mutex.run(() => planCycle(n));
			if (plan.kind === "stop") stopping = true;
			if (plan.kind === "idle") {
				setLane(n, `idle ${plan.minutes}m`);
				await nap(halted, sleep, plan.minutes * 60_000);
			}
			if (plan.kind === "run") {
				const code = await execute(plan.action, plan.topic, runner, cfg, plan.brief, n);
				const reason = recordRun(plan, code);
				// Back off after a failed run so a deterministic failure does not spin.
				if (reason !== "complete") {
					setLane(n, `backoff ${cfg.idleMinutes}m`);
					await nap(halted, sleep, cfg.idleMinutes * 60_000);
				}
			}
		} catch (e) {
			log(`[lane ${n}] ${String(e)}`);
			record({ ts: now(), lane: n, rationale: "lane error", outcome: { reason: "error", exitCode: 1 } });
			await nap(halted, sleep, cfg.idleMinutes * 60_000);
		} finally {
			for (const [slug, l] of busy) if (l === n) busy.delete(slug);
			setLane(n, undefined);
		}
	}

	const p0 = readPortfolio(root);
	seedExistingTopics(p0, cfg, topicsRoot);
	writePortfolio(root, p0);
	reconcile(root, topicsRoot, cfg, log, busy);
	const maxCycles = cfg.maxCycles ?? Number.POSITIVE_INFINITY;
	for (;;) {
		stopping ||= stopRequested(root) || cyclesUsed >= maxCycles;
		external = externalLocks(topicsRoot, busy);
		// External runs count toward the lane total, so -p 2 means at most two research runs.
		while (!stopping && cyclesUsed < maxCycles && lanes.size + external.length < cfg.lanes) {
			let n = 1;
			while (lanes.has(n)) n++;
			lanes.set(n, runLane(n).finally(() => lanes.delete(n)));
		}
		if (stopping && lanes.size === 0) break;
		status();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([...lanes.values(), new Promise<void>((r) => (timer = setTimeout(r, tickMs)))]);
		clearTimeout(timer);
		reconcile(root, topicsRoot, cfg, log, busy);
	}
	status(false);
}

/** Run reason: this run's end event if it wrote one, else from the CLI exit code (1 lock held, 2 bad args, 130 signal). */
function runReason(action: Action, code: number, end: RunEndRec | undefined): string {
	if (action.kind === "preprint") return code === 0 ? "complete" : "error";
	if (end) return endReason(end);
	return code === 0 ? "complete" : code === 1 ? "locked" : code === 2 ? "invalid" : code === 130 ? "signal" : "error";
}

/** runs.jsonl sizes before a launch, to find that launch's own end event afterwards. */
interface RunMark {
	startsBefore: number;
	endsBefore: number;
}
const runMark = (topic: TopicPaths): RunMark => ({ startsBefore: runStarts(topic.runs).length, endsBefore: runEnds(topic.runs).length });

/** The newest end written after the mark that does not belong to a run started before it (a run that failed early writes none). */
function ownRunEnd(topic: TopicPaths, mark: RunMark): RunEndRec | undefined {
	const earlier = new Set(runStarts(topic.runs).slice(0, mark.startsBefore).map((s) => s.runId));
	return runEnds(topic.runs).slice(mark.endsBefore).findLast((e) => !earlier.has(e.runId));
}

function finishRun(rec: TopicRecord, action: Action, vnBefore: string[], mark: RunMark, topic: TopicPaths, code: number, cfg: DriverConfig): string {
	const after = loadFindings(topic);
	const end = ownRunEnd(topic, mark);
	const reason = runReason(action, code, end);
	applyOutcome(rec, { action, vnBefore, vnAfter: verifiedNovelIds(after), reason, ts: new Date().toISOString() }, cfg);
	if (end) rec.lastRunId = end.runId;
	return reason;
}

function outcomeOf(rec: TopicRecord | undefined, topic: TopicPaths, code: number, reason: string): Decision["outcome"] {
	const after = loadFindings(topic);
	return { reason, exitCode: code, findings: after.length, verifiedNovel: rec?.verifiedNovel };
}

// Entry point: driver -t "Topic" [-b brief.md] [-a area] [-c n] [--heuristic]  |  driver [-p lanes] [-c n] (roam across the portfolio)
if (import.meta.filename === process.argv[1] || process.argv[1]?.endsWith("driver.ts")) {
	const envFile = join(REPO_ROOT, ".env");
	if (existsSync(envFile)) process.loadEnvFile(envFile);
	const { values } = parseArgs({
		options: {
			topic: { type: "string", short: "t" },
			brief: { type: "string", short: "b" },
			area: { type: "string", short: "a" },
			parallel: { type: "string", short: "p" },
			concurrency: { type: "string", short: "c", default: "3" },
			heuristic: { type: "boolean", default: false },
		},
	});
	const lanes = Number(values.parallel ?? "1");
	const concurrency = Number(values.concurrency);
	if (!Number.isInteger(lanes) || lanes < 1 || lanes > 4 || !Number.isInteger(concurrency) || concurrency < 1) {
		console.error("-p must be 1-4 and -c a positive integer");
		process.exit(2);
	}
	if (values.parallel !== undefined && values.topic) {
		console.error("-p does not apply to single-topic mode (-t)");
		process.exit(2);
	}
	const log = (l: string) => console.log(l);
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));
	// No -t: roam the whole portfolio (the autonomous default).
	if (!values.topic) {
		const models = await ModelRuntime.create();
		const cfg: DriverConfig = { ...DEFAULT_CONFIG, lanes, concurrency };
		log(`[driver] roaming with ${lanes} lane(s), concurrency ${concurrency}`);
		await runPortfolio({ root: PORTFOLIO_DIR, runner: defaultRunner, cfg, select: makeSelector(models, log), decide: makeAnalyst(models, log), log });
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
	const cfg: DriverConfig = { ...DEFAULT_CONFIG, concurrency, ...(values.area ? { area: values.area } : {}), ...(values.brief ? { brief: values.brief } : {}) };
	const decide = values.heuristic ? heuristicDecider : makeAnalyst(await ModelRuntime.create(), log);
	await runDriver({ topic, root: PORTFOLIO_DIR, runner: defaultRunner, cfg, decide, log });
}
