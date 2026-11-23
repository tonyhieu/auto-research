// Driver-side state under portfolio/: the topic portfolio, the decision log, the live
// heartbeat, and the STOP flag. Pure helpers plus small file I/O; no LLM, no research.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
}

export interface Portfolio {
	topics: TopicRecord[];
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
}

export interface DriverStatus {
	running: boolean;
	pid: number;
	startedAt: string;
	heartbeatAt: string;
	currentAction?: Action | null;
	/** Short human label for the current cycle (used by the roaming loop). */
	label?: string;
	lastDecision?: Decision;
}

export interface DriverConfig {
	area: string;
	windows: number;
	maxConsecutiveFocus: number;
	barrenLimit: number;
	idleMinutes: number;
	/** Test-only: stop the loop after this many cycles. */
	maxCycles?: number;
	/** Forwarded to breadth runs so a new topic gets its brief. */
	brief?: string;
}

export const DEFAULT_CONFIG: DriverConfig = { area: "default", windows: 2, maxConsecutiveFocus: 3, barrenLimit: 2, idleMinutes: 30 };

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

export function writePortfolio(root: string, p: Portfolio): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(paths(root).portfolio, JSON.stringify(p, null, 2) + "\n");
}

/** Find the record for a topic, creating an active one on first sight. */
export function topicRecord(p: Portfolio, slug: string, title: string, area: string): TopicRecord {
	let rec = p.topics.find((t) => t.slug === slug);
	if (!rec) {
		rec = { slug, title, area, status: "active", runs: 0, verifiedNovel: 0, consecutiveFocus: 0, consecutiveBarrenRuns: 0, deepened: [], preprinted: [] };
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

/** Last run end event the harness wrote, for the outcome of the run the driver just launched. */
export function lastRunEnd(runsPath: string): { reason: string; exitCode: number; findings: number } | undefined {
	if (!existsSync(runsPath)) return undefined;
	const ends = readFileSync(runsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return undefined;
			}
		})
		.filter((e) => e?.event === "end");
	return ends.at(-1);
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
	if (rec.status === "exhausted") return { kind: "stop", reason: "topic exhausted" };
	return { kind: "breadth", windows: cfg.windows };
}

/** Fold a finished run into the topic record, and mark the topic exhausted when nothing is left to do. */
export function applyOutcome(
	rec: TopicRecord,
	o: { action: Action; vnBefore: string[]; vnAfter: string[]; reason: string; ts: string },
	cfg: DriverConfig,
): void {
	rec.runs++;
	rec.lastRunAt = o.ts;
	rec.lastReason = o.reason;
	rec.verifiedNovel = o.vnAfter.length;
	const gained = o.vnAfter.some((id) => !o.vnBefore.includes(id));
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
