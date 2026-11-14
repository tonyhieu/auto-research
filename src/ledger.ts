import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type FindingStatus = "unverified" | "verified" | "refuted";

/** literature = what papers show; gap = absence claim; insight = own inference/hypothesis. */
export type FindingKind = "literature" | "gap" | "insight";

export interface Finding {
	id: string;
	ts: string;
	author: string;
	taskId?: string;
	/** Missing on entries written before kinds existed. */
	kind?: FindingKind;
	claim: string;
	evidence: string;
	/** Semantic Scholar paperIds (or other stable ids) backing the claim. */
	sources: string[];
	/** As written; the effective status comes from verifications (see loadFindings). */
	status: FindingStatus;
	/** Derived from novelty verdicts; only set by loadFindings. */
	novelty?: "novel" | "known";
	/** focus-target: a free-text focus hypothesis; a refuting focus verdict settles it. */
	role?: "focus-target";
}

/** reproduce: an independent rerun from the written setup (focus mode only). */
export type VerificationCheck = "citation" | "adversarial" | "novelty" | "reproduce";
export type Verdict = "pass" | "fail" | "inconclusive";

export interface Verification {
	id: string;
	ts: string;
	findingId: string;
	check: VerificationCheck;
	verdict: Verdict;
	rationale: string;
	/** Papers checked (novelty/citation) or supporting a refutation. */
	sources: string[];
	by: string;
}

/** Only insights (and legacy unkinded entries) can rest on a computation, so only they get a reproduce check. */
export const reproducible = (f: Finding) => f.kind !== "gap" && f.kind !== "literature";

/**
 * Gaps and insights are candidate new results; legacy unkinded entries are treated the same.
 * A refuted focus target is settled by its focus verdict; any other target is still verified normally.
 */
export const needsVerification = (f: Finding) => f.kind !== "literature" && !(f.role === "focus-target" && f.status === "refuted");

export type TaskStatus = "open" | "claimed" | "done";

export interface Task {
	id: string;
	created: string;
	title: string;
	description: string;
	status: TaskStatus;
	/** Missing means research. */
	type?: "research" | "verify";
	/** For verify tasks. */
	findingId?: string;
	/** For research tasks: findings whose verifier objections this task follows up on. */
	addresses?: string[];
	assignee?: string;
	/** Focus key (see focus.ts) for tasks created by a focus run; missing means breadth mode. */
	focus?: string;
	/** Progress notes from interrupted attempts, shown to the next assignee. */
	notes?: string[];
	/** Failed attempts that count toward a retry cap; budget interruptions do not count. */
	retries?: number;
}

const shortId = () => randomUUID().slice(0, 8);

/** Parse JSON, returning undefined on malformed input (e.g. a line truncated by a crash). */
function tryParse<T>(s: string): T | undefined {
	try {
		return JSON.parse(s) as T;
	} catch {
		return undefined;
	}
}

export function appendFinding(ledgerPath: string, f: Omit<Finding, "id" | "ts">): Finding {
	const full: Finding = { id: `f-${shortId()}`, ts: new Date().toISOString(), ...f };
	// One line per write; appends under PIPE_BUF are atomic on POSIX.
	appendFileSync(ledgerPath, JSON.stringify(full) + "\n");
	return full;
}

export function readFindings(ledgerPath: string): Finding[] {
	return readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => tryParse<Finding>(l))
		.filter((f): f is Finding => f !== undefined);
}

export interface FindingQuery {
	query?: string;
	status?: FindingStatus;
	taskId?: string;
	/** ISO timestamp; only findings recorded after it. */
	since?: string;
	limit?: number;
}

export function appendVerification(path: string, v: Omit<Verification, "id" | "ts">): Verification {
	const full: Verification = { id: `v-${shortId()}`, ts: new Date().toISOString(), ...v };
	appendFileSync(path, JSON.stringify(full) + "\n");
	return full;
}

export function readVerifications(path: string): Verification[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => tryParse<Verification>(l))
		.filter((v): v is Verification => v !== undefined);
}

/**
 * Effective status from the latest verdict per check: a failed citation or adversarial check
 * refutes; both passing verifies. Novelty is reported separately (a known result is not false).
 * A reproduce verdict, when recorded, must also pass to verify; a failed one refutes.
 */
export function applyVerifications(findings: Finding[], vs: Verification[]): Finding[] {
	const latest = new Map<string, Map<VerificationCheck, Verdict>>();
	for (const v of [...vs].sort((a, b) => a.ts.localeCompare(b.ts))) {
		if (!latest.has(v.findingId)) latest.set(v.findingId, new Map());
		latest.get(v.findingId)!.set(v.check, v.verdict);
	}
	return findings.map((f) => {
		const m = latest.get(f.id);
		if (!m) return f;
		const rep = reproducible(f) ? m.get("reproduce") : undefined;
		const status: FindingStatus =
			m.get("citation") === "fail" || m.get("adversarial") === "fail" || rep === "fail"
				? "refuted"
				: m.get("citation") === "pass" && m.get("adversarial") === "pass" && (rep === undefined || rep === "pass")
					? "verified"
					: f.status;
		const n = m.get("novelty");
		return { ...f, status, novelty: n === "pass" ? "novel" : n === "fail" ? "known" : undefined };
	});
}

/** Findings with status/novelty derived from verifications. */
export function loadFindings(t: { ledger: string; verifications: string }): Finding[] {
	return applyVerifications(readFindings(t.ledger), readVerifications(t.verifications));
}

/** Task ids of a focus run's tasks. */
export const focusTaskIds = (tasks: Task[], focus: string) => new Set(tasks.filter((x) => x.focus === focus).map((x) => x.id));

/**
 * Queue one verify task per gap/insight finding that has never had one. Returns how many were created.
 * With `focus`, only findings from that focus run's tasks, and the verify tasks are tagged with it.
 */
export function enqueueVerifyTasks(t: { ledger: string; verifications: string; tasks: string }, focus?: string): number {
	const tasks = listTasks(t.tasks);
	const covered = new Set(tasks.map((x) => x.findingId).filter(Boolean));
	const mine = focus ? focusTaskIds(tasks, focus) : undefined;
	let n = 0;
	for (const f of loadFindings(t)) {
		if (!needsVerification(f) || covered.has(f.id)) continue;
		if (mine && !mine.has(f.taskId ?? "")) continue;
		createTask(t.tasks, `Verify ${f.id}`, f.claim, { type: "verify", findingId: f.id, focus });
		n++;
	}
	return n;
}

/** Verification attempts allowed per finding (initial + re-verifications after follow-up research). */
export const MAX_VERIFY_ATTEMPTS = 3;

/** Settled = refuted, or verified with a novelty verdict. Everything else can still move. */
const settled = (f: Finding) => f.status === "refuted" || (f.status === "verified" && f.novelty !== undefined);

const active = (x: Task) => x.status !== "done";

/** Of `ids`, the unverified findings that can still be verified in this mode: a verify task is active or attempts remain. */
export function verificationPending(t: { ledger: string; verifications: string; tasks: string }, ids: string[], focus?: string): string[] {
	const tasks = listTasks(t.tasks);
	const findings = new Map(loadFindings(t).map((f) => [f.id, f]));
	return ids.filter((id) => {
		if (findings.get(id)?.status !== "unverified") return false;
		const attempts = tasks.filter((x) => x.type === "verify" && x.findingId === id && x.focus === focus);
		return attempts.some(active) || attempts.length < MAX_VERIFY_ATTEMPTS;
	});
}

/**
 * After follow-up research finishes, queue a fresh verify task for each addressed finding that is
 * still unsettled, under the attempt cap and not already queued. Returns the finding ids queued.
 * Attempts are counted per mode, so a focus run can re-verify a finding the breadth run capped.
 */
export function requeueVerification(
	t: { ledger: string; verifications: string; tasks: string },
	research: Pick<Task, "addresses" | "focus">,
): string[] {
	const tasks = listTasks(t.tasks);
	const findings = new Map(loadFindings(t).map((f) => [f.id, f]));
	const queued: string[] = [];
	for (const id of research.addresses ?? []) {
		const f = findings.get(id);
		const attempts = tasks.filter((x) => x.type === "verify" && x.findingId === id && x.focus === research.focus);
		if (!f || settled(f) || attempts.length >= MAX_VERIFY_ATTEMPTS || attempts.some(active)) continue;
		createTask(t.tasks, `Re-verify ${id}`, f.claim, { type: "verify", findingId: id, focus: research.focus });
		queued.push(id);
	}
	return queued;
}

export interface Objection {
	finding: Finding;
	/** Latest non-pass verdict per check. */
	open: Verification[];
}

/**
 * Verified-against-but-unsettled findings that nobody is working on: the verifier raised objections,
 * attempts remain, and no open verify task or open research task addresses them. Newest first.
 * With `focus`, only the focus target and findings from that focus run's tasks.
 */
export function openObjections(
	t: { ledger: string; verifications: string; tasks: string },
	limit = 8,
	focus?: { key: string; findingId?: string },
): Objection[] {
	const tasks = listTasks(t.tasks);
	const mine = focus ? focusTaskIds(tasks, focus.key) : undefined;
	const vs = readVerifications(t.verifications).sort((a, b) => a.ts.localeCompare(b.ts));
	const busy = new Set(
		tasks.filter(active).flatMap((x) => (x.type === "verify" ? [x.findingId ?? ""] : (x.addresses ?? []))),
	);
	const out: Objection[] = [];
	for (const f of loadFindings(t).toReversed()) {
		const vsOf = vs.filter((v) => v.findingId === f.id);
		if (mine && !mine.has(f.taskId ?? "") && f.id !== focus?.findingId) continue;
		const attempts = tasks.filter((x) => x.type === "verify" && x.findingId === f.id && x.focus === focus?.key).length;
		if (!vsOf.length || settled(f) || busy.has(f.id) || attempts >= MAX_VERIFY_ATTEMPTS) continue;
		const latest = new Map(vsOf.map((v) => [v.check, v]));
		out.push({ finding: f, open: [...latest.values()].filter((v) => v.verdict !== "pass") });
		if (out.length >= limit) break;
	}
	return out;
}

const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [];

/**
 * Filter findings, then rank: by keyword overlap with `query` (claim counts double), else newest first.
 * Returns the page plus how many matched, so callers can say "showing 20 of 143".
 */
export function queryFindings(all: Finding[], q: FindingQuery): { items: Finding[]; matched: number } {
	let fs = all.filter(
		(f) =>
			(!q.status || f.status === q.status) &&
			(!q.taskId || f.taskId === q.taskId) &&
			(!q.since || f.ts > q.since),
	);
	const newestFirst = (a: Finding, b: Finding) => b.ts.localeCompare(a.ts);
	const terms = [...new Set(tokens(q.query ?? ""))];
	if (terms.length) {
		const score = (f: Finding) => {
			const claim = new Set(tokens(f.claim));
			const rest = new Set(tokens(`${f.evidence} ${f.sources.join(" ")}`));
			return terms.reduce((s, t) => s + (claim.has(t) ? 2 : 0) + (rest.has(t) ? 1 : 0), 0);
		};
		const scored = fs.map((f) => ({ f, s: score(f) })).filter((x) => x.s > 0);
		scored.sort((a, b) => b.s - a.s || newestFirst(a.f, b.f));
		fs = scored.map((x) => x.f);
	} else fs = [...fs].sort(newestFirst);
	return { items: fs.slice(0, q.limit ?? 20), matched: fs.length };
}

export function createTask(
	tasksDir: string,
	title: string,
	description: string,
	extra: Pick<Task, "type" | "findingId" | "addresses" | "focus"> = {},
): Task {
	// Drop undefined fields so breadth tasks keep the original on-disk shape.
	const tags = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
	const t: Task = { id: `t-${shortId()}`, created: new Date().toISOString(), title, description, status: "open", ...tags };
	writeFileSync(join(tasksDir, `${t.id}.json`), JSON.stringify(t, null, 2));
	return t;
}

export function listTasks(tasksDir: string): Task[] {
	return readdirSync(tasksDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => tryParse<Task>(readFileSync(join(tasksDir, f), "utf8")))
		.filter((t): t is Task => t !== undefined)
		.sort((a, b) => a.created.localeCompare(b.created));
}

export function updateTask(tasksDir: string, t: Task): void {
	writeFileSync(join(tasksDir, `${t.id}.json`), JSON.stringify(t, null, 2));
}

/** Failed attempts after which a task is given up instead of re-claimed. */
export const MAX_TASK_RETRIES = 2;

/**
 * Claim the oldest open task, verify tasks first, optionally restricted by `allow`. Synchronous on purpose:
 * all agents for a topic share one process (enforced by the topic lock), so no await between read and write = atomic.
 */
export function claimNextTask(tasksDir: string, assignee: string, allow: (t: Task) => boolean = () => true): Task | undefined {
	const candidates = listTasks(tasksDir).filter((x) => x.status === "open" && allow(x));
	const exhausted = (x: Task) => (x.retries ?? 0) >= MAX_TASK_RETRIES;
	// A task that keeps failing would otherwise be re-claimed forever.
	for (const x of candidates.filter(exhausted)) {
		updateTask(tasksDir, { ...x, status: "done", notes: [...(x.notes ?? []), `Gave up after ${x.retries} failed attempts.`] });
	}
	const open = candidates.filter((x) => !exhausted(x));
	const t = open.find((x) => x.type === "verify") ?? open[0];
	if (!t) return undefined;
	const claimed: Task = { ...t, status: "claimed", assignee };
	updateTask(tasksDir, claimed);
	return claimed;
}

/** Put an interrupted task back in the queue with a note for whoever picks it up next. */
export function releaseTask(tasksDir: string, t: Task, note: string, { retry = false } = {}): void {
	const retries = retry ? { retries: (t.retries ?? 0) + 1 } : {};
	updateTask(tasksDir, { ...t, status: "open", assignee: undefined, notes: [...(t.notes ?? []), note], ...retries });
}

/** Re-open tasks left claimed by a crashed run. */
export function resetStaleClaims(tasksDir: string): number {
	const stale = listTasks(tasksDir).filter((t) => t.status === "claimed");
	for (const t of stale) releaseTask(tasksDir, t, "Previous run ended before this task finished.");
	return stale.length;
}
