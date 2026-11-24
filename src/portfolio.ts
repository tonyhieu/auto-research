// Driver-side state under portfolio/: the topic portfolio, the decision log, the live
// heartbeat, and the STOP flag. Pure helpers plus small file I/O; no LLM, no research.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./ledger.ts";
import { REPO_ROOT } from "./topic.ts";

export const PORTFOLIO_DIR = join(REPO_ROOT, "portfolio");

export type TopicStatus = "active" | "exhausted" | "retired";

export interface TopicRecord {
	slug: string;
	title: string;
	area: string;
	status: TopicStatus;
	runs: number;
	lastRunAt?: string;
	lastReason?: string;
	/** Count of verified+novel findings at the last run's end. */
	verifiedNovel: number;
	/** Focus runs in a row, so one claim is not ground forever. */
	consecutiveFocus: number;
	/** Breadth/focus runs in a row that added no new verified+novel finding. */
	consecutiveBarrenRuns: number;
	/** Finding ids a focus run has been issued for. */
	deepened: string[];
	/** Finding ids a pre-print has been written for. */
	preprinted: string[];
	/** Failed runs in a row; the second retires the topic. Optional for older portfolio.json files. */
	consecutiveErrors?: number;
	/** runId of the last harness run applied to this record (driver-launched or reconciled). */
	lastRunId?: string;
}

export interface Portfolio {
	topics: TopicRecord[];
	/** When the driver last started a new topic, to rate-limit new areas. */
	lastNewTopicAt?: string;
}

/** The heuristic decider's output; the loop knows the single phase-1 topic, so no topic field yet. */
export type Action =
	| { kind: "breadth"; windows: number }
	| { kind: "focus"; findingId?: string; hypothesis?: string; windows: number }
	| { kind: "preprint"; findingId: string }
	| { kind: "retire"; reason: string }
	| { kind: "idle"; minutes: number; reason: string }
	| { kind: "stop"; reason: string };

/** Portfolio-level roaming choice, above the per-topic Action. */
export type SelectDecision =
	| { kind: "work"; slug: string }
	| { kind: "new-topic"; title: string; area: string; brief: string }
	| { kind: "idle"; minutes: number; reason: string }
	| { kind: "stop"; reason: string };

export interface Decision {
	ts: string;
	rationale: string;
	/** The topic-scoped action taken; absent for a pure selection such as idle or stop. */
	action?: Action;
	/** The portfolio-level selection, when the driver roams across topics. */
	select?: SelectDecision;
	slug?: string;
	outcome?: { reason: string; exitCode: number; findings?: number; verifiedNovel?: number };
	lane?: number;
	/** Outcome applied after the fact for a run this driver did not see finish. */
	reconciled?: boolean;
}

export interface LaneStatus {
	lane: number;
	/** e.g. "select", "focus diversity-weighted-synthetic-data", "idle 30m". */
	label: string;
	slug?: string;
	action?: Action;
	since: string;
}

export interface DriverStatus {
	running: boolean;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	lanes: LaneStatus[];
	/** Locked topics this driver did not launch (manual, UI, or orphaned runs). */
	external: { slug: string; pid: number }[];
	lastDecision?: Decision;
}

export interface DriverConfig {
	area: string;
	windows: number;
	maxConsecutiveFocus: number;
	barrenLimit: number;
	newTopicCooldownHours: number;
	idleMinutes: number;
	/** Test-only: stop the loop after this many cycles. */
	maxCycles?: number;
	/** Forwarded to breadth runs so a new topic gets its brief. */
	brief?: string;
	/** Parallel lanes (research runs) the roaming loop keeps busy. */
	lanes: number;
	/** Forwarded to bin/research as -c. */
	concurrency: number;
}

export const DEFAULT_CONFIG: DriverConfig = { area: "default", windows: 2, maxConsecutiveFocus: 3, barrenLimit: 2, newTopicCooldownHours: 12, idleMinutes: 30, lanes: 1, concurrency: 3 };

const paths = (root: string) => ({
	portfolio: join(root, "portfolio.json"),
	decisions: join(root, "decisions.jsonl"),
	status: join(root, "driver.json"),
	stop: join(root, "STOP"),
});

export function verifiedNovelIds(findings: Finding[]): string[] {
	return findings.filter((f) => f.status === "verified" && f.novelty === "novel").map((f) => f.id);
}

export function readPortfolio(root: string): Portfolio {
	const p = paths(root).portfolio;
	if (!existsSync(p)) return { topics: [] };
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return { topics: [] };
	}
}

/** Atomic write (tmp + rename) so arui and other lanes never read a half-written file. */
export function writePortfolio(root: string, p: Portfolio): void {
	mkdirSync(root, { recursive: true });
	const file = paths(root).portfolio;
	writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 2) + "\n");
	renameSync(`${file}.tmp`, file);
}

/** Re-read, mutate one topic record, write back. Synchronous, so lanes cannot interleave. */
export function updateRecord(root: string, slug: string, fn: (rec: TopicRecord, p: Portfolio) => void): TopicRecord | undefined {
	const p = readPortfolio(root);
	const rec = p.topics.find((t) => t.slug === slug);
	if (!rec) return undefined;
	fn(rec, p);
	writePortfolio(root, p);
	return rec;
}

/** Find the record for a topic, creating an active one on first sight. */
export function topicRecord(p: Portfolio, slug: string, title: string, area: string): TopicRecord {
	let rec = p.topics.find((t) => t.slug === slug);
	if (!rec) {
		rec = { slug, title, area, status: "active", runs: 0, verifiedNovel: 0, consecutiveFocus: 0, consecutiveBarrenRuns: 0, deepened: [], preprinted: [], consecutiveErrors: 0 };
		p.topics.push(rec);
	}
	return rec;
}

export function appendDecision(root: string, d: Decision): void {
	mkdirSync(root, { recursive: true });
	appendFileSync(paths(root).decisions, JSON.stringify(d) + "\n");
}

export function writeStatus(root: string, s: DriverStatus): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(paths(root).status, JSON.stringify(s, null, 2) + "\n");
}

export const stopRequested = (root: string): boolean => existsSync(paths(root).stop);
export const requestStop = (root: string): void => {
	mkdirSync(root, { recursive: true });
	writeFileSync(paths(root).stop, "");
};
export const clearStop = (root: string): void => rmSync(paths(root).stop, { force: true });

export interface RunStartRec {
	event: "start";
	runId: string;
	ts: string;
	mode: "breadth" | "focus";
	target?: string;
	windows: number;
}
export interface RunEndRec {
	event: "end";
	runId: string;
	ts: string;
	reason: string;
	exitCode: number;
	findings: number;
	/** Research and verify agents the run launched; absent in older events and on signal/error exits. */
	agents?: number;
}

/** "empty" when a run completed without launching any agent (budget exhausted, no sandbox): no evidence either way. */
export function endReason(end: RunEndRec): string {
	return end.reason === "complete" && end.agents === 0 ? "empty" : end.reason;
}
export interface RunPair {
	start: RunStartRec;
	end: RunEndRec;
}

/** Every start/end event in state/runs.jsonl, in file order. */
export function runEvents(runsPath: string): (RunStartRec | RunEndRec)[] {
	if (!existsSync(runsPath)) return [];
	return readFileSync(runsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return undefined;
			}
		})
		.filter((e) => e?.event === "start" || e?.event === "end");
}

/** All run end events the harness wrote to state/runs.jsonl. */
export function runEnds(runsPath: string): RunEndRec[] {
	return runEvents(runsPath).filter((e): e is RunEndRec => e.event === "end");
}

export const runStarts = (runsPath: string): RunStartRec[] => runEvents(runsPath).filter((e): e is RunStartRec => e.event === "start");

/** The newest end event, only if one was appended after the first `since` (a run that failed before recording writes none). */
export function lastRunEnd(runsPath: string, since = 0): RunEndRec | undefined {
	const ends = runEnds(runsPath);
	return ends.length > since ? ends.at(-1) : undefined;
}

/** Finished runs after the record's lastRunId (or after lastRunAt when lastRunId is unset). */
export function unaccountedRuns(runsPath: string, rec: TopicRecord): RunPair[] {
	const events = runEvents(runsPath);
	let from = 0;
	if (rec.lastRunId) {
		const i = events.findLastIndex((e) => e.runId === rec.lastRunId);
		if (i < 0) return []; // marker not in this file; apply nothing rather than guess
		from = i + 1;
	} else if (!rec.lastRunAt) return [];
	const ends = new Map(events.slice(from).filter((e): e is RunEndRec => e.event === "end").map((e) => [e.runId, e]));
	return events
		.slice(from)
		.filter((e): e is RunStartRec => e.event === "start" && ends.has(e.runId))
		.filter((s) => rec.lastRunId || Date.parse(s.ts) > Date.parse(rec.lastRunAt!))
		.map((start) => ({ start, end: ends.get(start.runId)! }));
}

/** Rebuild the driver action from a start record: breadth, or focus on a finding id / hypothesis. */
export function actionOfStart(s: RunStartRec): Action {
	const windows = Number.isInteger(s.windows) && s.windows >= 1 ? s.windows : 1;
	if (s.mode !== "focus") return { kind: "breadth", windows };
	const target = s.target ?? "";
	return /^f-[0-9a-f]{8}$/.test(target) ? { kind: "focus", findingId: target, windows } : { kind: "focus", hypothesis: target, windows };
}

/**
 * The phase-1 heuristic, by precedence: pre-print a deepened verified-novel finding, else
 * deepen (focus) a verified-novel one, else stop if exhausted, else explore (breadth).
 */
export function decideNext(opts: { findings: Finding[]; rec: TopicRecord; cfg: DriverConfig }): Action {
	const { findings, rec, cfg } = opts;
	const vn = verifiedNovelIds(findings);
	const toPreprint = vn.find((id) => rec.deepened.includes(id) && !rec.preprinted.includes(id));
	if (toPreprint) return { kind: "preprint", findingId: toPreprint };
	const toDeepen = vn.find((id) => !rec.deepened.includes(id));
	if (toDeepen && rec.consecutiveFocus < cfg.maxConsecutiveFocus) return { kind: "focus", findingId: toDeepen, windows: cfg.windows };
	if (rec.status !== "active") return { kind: "stop", reason: `topic ${rec.status}` };
	return { kind: "breadth", windows: cfg.windows };
}

/** Fold a finished run into the topic record, and mark the topic exhausted when nothing is left to do. */
export function applyOutcome(
	rec: TopicRecord,
	o: { action: Action; vnBefore: string[]; vnAfter: string[]; reason: string; ts: string; gained?: boolean },
	cfg: DriverConfig,
): void {
	// A lock conflict means nothing ran.
	if (o.reason === "locked") return;
	rec.runs++;
	rec.lastRunAt = o.ts;
	rec.lastReason = o.reason;
	rec.verifiedNovel = o.vnAfter.length;
	// A failed run is no evidence about the topic: do not mark deepened/preprinted or barren. Second error in a row retires it.
	if (o.reason !== "complete") {
		if (o.reason === "signal" || o.reason === "empty") return;
		rec.consecutiveErrors = (rec.consecutiveErrors ?? 0) + 1;
		if (rec.consecutiveErrors >= 2) rec.status = "retired";
		return;
	}
	rec.consecutiveErrors = 0;
	const gained = o.gained ?? o.vnAfter.some((id) => !o.vnBefore.includes(id));
	if (o.action.kind === "focus") {
		rec.consecutiveFocus++;
		if (o.action.findingId && !rec.deepened.includes(o.action.findingId)) rec.deepened.push(o.action.findingId);
	} else {
		rec.consecutiveFocus = 0;
	}
	if (o.action.kind === "preprint" && !rec.preprinted.includes(o.action.findingId)) rec.preprinted.push(o.action.findingId);
	if (o.action.kind === "breadth" || o.action.kind === "focus") rec.consecutiveBarrenRuns = gained ? 0 : rec.consecutiveBarrenRuns + 1;
	// Exhausted = no verified-novel finding still needs deepening or a pre-print, and breadth has stopped paying off.
	const pending = o.vnAfter.some((id) => !rec.deepened.includes(id) || !rec.preprinted.includes(id));
	if (!pending && rec.consecutiveBarrenRuns >= cfg.barrenLimit) rec.status = "exhausted";
}

export function rationale(action: Action, vn: string[]): string {
	switch (action.kind) {
		case "preprint":
			return `verified-novel ${action.findingId} was deepened; writing a pre-print`;
		case "focus":
			return action.findingId ? `verified-novel ${action.findingId} not yet deepened; focus run to stress-test it` : "focus run on a new hypothesis";
		case "retire":
			return action.reason;
		case "breadth":
			return vn.length ? "no undeepened verified-novel findings; another breadth window" : "no verified-novel findings yet; breadth exploration";
		case "idle":
			return action.reason;
		case "stop":
			return action.reason;
	}
}
