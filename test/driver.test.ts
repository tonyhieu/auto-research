import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAPER, VALID, why } from "./records.ts";
import { appendFinding, appendVerification, readFindings } from "../src/ledger.ts";
import { applyOutcome, DEFAULT_CONFIG, decideNext, type DriverConfig, type TopicRecord, writePortfolio } from "../src/portfolio.ts";
import { type Decider, runDriver, runPortfolio, type Runner } from "../src/driver.ts";
import type { Selector } from "../src/analyst.ts";
import { ensureTopic, type TopicPaths } from "../src/topic.ts";

const rec = (over: Partial<TopicRecord> = {}): TopicRecord => ({
	slug: "t",
	title: "T",
	area: "default",
	status: "active",
	runs: 0,
	verifiedNovel: 0,
	consecutiveFocus: 0,
	consecutiveBarrenRuns: 0,
	deepened: [],
	preprinted: [],
	...over,
});
const vn = (id: string) => ({ id, status: "verified", novelty: "novel" }) as any;

test("decideNext: pre-print a deepened lead before deepening a new one", () => {
	const findings = [vn("f-00000001"), vn("f-00000002")];
	const r = rec({ deepened: ["f-00000001"] });
	assert.deepEqual(decideNext({ findings, rec: r, cfg: DEFAULT_CONFIG }), { kind: "preprint", findingId: "f-00000001" });
});

test("decideNext: deepen an undeepened verified-novel finding, unless focus was just ground", () => {
	const findings = [vn("f-00000002")];
	assert.deepEqual(decideNext({ findings, rec: rec(), cfg: DEFAULT_CONFIG }), { kind: "focus", findingId: "f-00000002", windows: 2 });
	const ground = rec({ consecutiveFocus: DEFAULT_CONFIG.maxConsecutiveFocus });
	assert.equal(decideNext({ findings, rec: ground, cfg: DEFAULT_CONFIG }).kind, "breadth");
});

test("decideNext: breadth when nothing is verified-novel; stop when exhausted", () => {
	assert.equal(decideNext({ findings: [], rec: rec(), cfg: DEFAULT_CONFIG }).kind, "breadth");
	assert.deepEqual(decideNext({ findings: [], rec: rec({ status: "exhausted" }), cfg: DEFAULT_CONFIG }), { kind: "stop", reason: "topic exhausted" });
});

test("applyOutcome: a new verified-novel finding clears barren; a dry breadth run marks exhaustion", () => {
	const r = rec({ deepened: ["f-1"], preprinted: ["f-1"], consecutiveBarrenRuns: 1 });
	applyOutcome(r, { action: { kind: "breadth", windows: 2 }, vnBefore: ["f-1"], vnAfter: ["f-1", "f-2"], reason: "complete", ts: "t" }, DEFAULT_CONFIG);
	assert.equal(r.consecutiveBarrenRuns, 0, "a new lead resets barren");
	assert.equal(r.status, "active");
	applyOutcome(r, { action: { kind: "breadth", windows: 2 }, vnBefore: ["f-1", "f-2"], vnAfter: ["f-1", "f-2"], reason: "complete", ts: "t" }, { ...DEFAULT_CONFIG, barrenLimit: 1 });
	assert.equal(r.status, "active", "f-2 still needs deepening, so not exhausted");
	r.deepened.push("f-2");
	r.preprinted.push("f-2");
	applyOutcome(r, { action: { kind: "breadth", windows: 2 }, vnBefore: ["f-1", "f-2"], vnAfter: ["f-1", "f-2"], reason: "complete", ts: "t" }, { ...DEFAULT_CONFIG, barrenLimit: 1 });
	assert.equal(r.status, "exhausted", "nothing left and breadth is barren");
});

test("applyOutcome: a failed run does not count as deepened or barren; a second error retires; a lock is a no-op", () => {
	const r = rec();
	const focus = { kind: "focus", findingId: "f-1", windows: 1 } as const;
	applyOutcome(r, { action: focus, vnBefore: ["f-1"], vnAfter: ["f-1"], reason: "locked", ts: "t" }, DEFAULT_CONFIG);
	assert.equal(r.runs, 0);
	applyOutcome(r, { action: focus, vnBefore: ["f-1"], vnAfter: ["f-1"], reason: "error", ts: "t" }, DEFAULT_CONFIG);
	assert.deepEqual([r.deepened, r.consecutiveBarrenRuns, r.consecutiveFocus, r.status], [[], 0, 0, "active"]);
	applyOutcome(r, { action: focus, vnBefore: ["f-1"], vnAfter: ["f-1"], reason: "invalid", ts: "t" }, DEFAULT_CONFIG);
	assert.equal(r.status, "retired");
});

test("runDriver: a launch that writes no end event is not read as the previous run's outcome", async () => {
	const root = mkdtempSync(join(tmpdir(), "ar-portfolio-"));
	const topic = ensureTopic("Driver Fail", mkdtempSync(join(tmpdir(), "ar-topics-")));
	endEvent(topic); // an earlier, successful run
	const runner: Runner = { research: async () => 2, preprint: async () => 0 };
	await runDriver({ topic, root, runner, cfg: { ...DEFAULT_CONFIG, maxCycles: 5 }, sleep: async () => {}, log: () => {} });
	const out = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).outcome.reason);
	assert.deepEqual(out, ["invalid", "invalid"], "two failures, then the topic is retired and the loop ends");
	assert.equal(JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8")).topics[0].status, "retired");
});

// Simulate a run: the fake runner writes a run-end event, and the first breadth run also records a verified-novel finding.
function addVerifiedNovel(topic: TopicPaths): string {
	const f = appendFinding(topic.ledger, { author: "sub-1", kind: "gap", claim: "A claim long enough to satisfy the schema minimum length rule.", ...VALID, status: "verified" });
	for (const check of ["citation", "adversarial", "novelty"] as const)
		appendVerification(topic.verifications, { findingId: f.id, check, verdict: "pass", rationale: why("holds"), sources: [PAPER], by: "ver-1" });
	return f.id;
}
const endEvent = (topic: TopicPaths) =>
	appendFileSync(topic.runs, JSON.stringify({ event: "end", runId: "r-test", ts: new Date().toISOString(), exitCode: 0, reason: "complete", findings: readFindings(topic.ledger).length }) + "\n");

test("runDriver drives breadth -> focus -> preprint -> breadth -> stop and records it", async () => {
	const root = mkdtempSync(join(tmpdir(), "ar-portfolio-"));
	const topic = ensureTopic("Driver Demo", mkdtempSync(join(tmpdir(), "ar-topics-")));
	let researchCalls = 0;
	const runner: Runner = {
		research: async () => {
			if (++researchCalls === 1) addVerifiedNovel(topic); // only the first breadth run finds something
			endEvent(topic);
			return 0;
		},
		preprint: async () => 0,
	};
	await runDriver({ topic, root, runner, cfg: { ...DEFAULT_CONFIG, windows: 1, barrenLimit: 2, maxCycles: 8 }, sleep: async () => {}, log: () => {} });

	const kinds = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action.kind);
	assert.deepEqual(kinds, ["breadth", "focus", "preprint", "breadth", "stop"]);
	const p = JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8"));
	const r = p.topics[0];
	assert.equal(r.status, "exhausted");
	assert.equal(r.runs, 4, "preprint counts as a run; stop does not");
	assert.equal(r.verifiedNovel, 1);
	assert.deepEqual([r.deepened.length, r.preprinted.length], [1, 1]);
	const status = JSON.parse(readFileSync(join(root, "driver.json"), "utf8"));
	assert.equal(status.running, false);
});

// --- Parallel lanes (runPortfolio with cfg.lanes > 1) ---

interface Call {
	args: string[];
	lane?: number;
	release: (code?: number) => void;
}
/** A runner whose runs stay pending until the test releases them; release writes a start/end pair like the harness. */
function deferredRunner(topicsRoot: string, fail?: (lane?: number) => boolean) {
	const calls: Call[] = [];
	let id = 0;
	const run = (args: string[], lane?: number) => {
		if (fail?.(lane)) return Promise.reject(new Error(`boom in lane ${lane}`));
		return new Promise<number>((resolve) =>
			calls.push({
				args,
				lane,
				release: (code = 0) => {
					const t = ensureTopic(args[1], topicsRoot);
					const runId = `r-${String(++id).padStart(8, "0")}`;
					appendFileSync(t.runs, JSON.stringify({ event: "start", runId, ts: new Date().toISOString(), mode: "breadth", windows: 1 }) + "\n");
					appendFileSync(t.runs, JSON.stringify({ event: "end", runId, ts: new Date().toISOString(), exitCode: code, reason: "complete", findings: 0 }) + "\n");
					resolve(code);
				},
			}),
		);
	};
	const runner: Runner = { research: run, preprint: run };
	return { runner, calls };
}
async function waitFor(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(cond(), `timed out waiting for ${what}`);
}
const dirs = () => ({ root: mkdtempSync(join(tmpdir(), "ar-portfolio-")), topicsRoot: mkdtempSync(join(tmpdir(), "ar-topics-")), queueDir: mkdtempSync(join(tmpdir(), "ar-queue-")) });
const decisions = (root: string) =>
	existsSync(join(root, "decisions.jsonl")) ? readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const portfolio = (root: string) => JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8"));
/** Picks the first topic not marked busy, else idles a minute. */
const firstFree: Selector = async ({ existing }) => {
	const t = existing.find((x) => !x.busy && x.status === "active");
	return t ? { decision: { kind: "work", slug: t.slug }, rationale: "free" } : { decision: { kind: "idle", minutes: 1, reason: "all busy" }, rationale: "busy" };
};
const breadth: Decider = async () => ({ action: { kind: "breadth", windows: 1 }, rationale: "explore" });
const laneCfg = (over: Partial<DriverConfig>): DriverConfig => ({ ...DEFAULT_CONFIG, windows: 1, ...over });
const quiet = { sleep: async () => {}, log: () => {}, tickMs: 5 };

test("runPortfolio lanes: two topics run at the same time", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	ensureTopic("Topic A", topicsRoot);
	ensureTopic("Topic B", topicsRoot);
	const { runner, calls } = deferredRunner(topicsRoot);
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 2 }), select: firstFree, decide: breadth, ...quiet });
	await waitFor(() => calls.length === 2, "two concurrent runs");
	assert.deepEqual(calls.map((c) => c.args[1]).sort(), ["Topic A", "Topic B"]);
	assert.deepEqual(calls.map((c) => c.lane).sort(), [1, 2]);
	assert.ok(calls[0].args.includes("-c"), "concurrency is forwarded");
	const status = JSON.parse(readFileSync(join(root, "driver.json"), "utf8"));
	assert.equal(status.lanes.length, 2);
	calls.forEach((c) => c.release());
	await done;
	assert.deepEqual(decisions(root).map((d) => d.lane).sort(), [1, 2]);
});

test("runPortfolio lanes: a busy topic is never double-booked", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	ensureTopic("Topic A", topicsRoot);
	ensureTopic("Topic B", topicsRoot);
	const { runner, calls } = deferredRunner(topicsRoot);
	const alwaysA: Selector = async () => ({ decision: { kind: "work", slug: "topic-a" }, rationale: "A again" });
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 3 }), select: alwaysA, decide: breadth, ...quiet });
	await waitFor(() => decisions(root).filter((d) => d.outcome?.reason === "busy").length === 2, "two busy rejections");
	assert.equal(calls.length, 1, "A launched once");
	calls[0].release();
	await done;
	assert.equal(portfolio(root).topics.find((t: TopicRecord) => t.slug === "topic-a").runs, 1);
});

test("runPortfolio lanes: updates from both lanes survive (no lost writes)", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	const ids: Record<string, string> = {};
	for (const title of ["Topic A", "Topic B"]) ids[title] = addVerifiedNovel(ensureTopic(title, topicsRoot));
	const { runner, calls } = deferredRunner(topicsRoot);
	const preprint: Decider = async ({ topic }) => ({ action: { kind: "preprint", findingId: ids[topic.title] }, rationale: "write it" });
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 2 }), select: firstFree, decide: preprint, ...quiet });
	await waitFor(() => calls.length === 2, "two runs");
	calls.find((c) => c.lane === 1)!.release();
	await waitFor(() => decisions(root).length === 1, "lane 1 recorded");
	calls.find((c) => c.lane === 2)!.release();
	await done;
	for (const title of ["Topic A", "Topic B"]) {
		const r = portfolio(root).topics.find((t: TopicRecord) => t.title === title);
		assert.equal(r.runs, 1, title);
		assert.deepEqual(r.preprinted, [ids[title]], title);
		assert.ok(r.lastRunId, `${title} remembers its run id`);
	}
});

test("runPortfolio lanes: an external lock fills a lane and its run is reconciled when it ends", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	const a = ensureTopic("Topic A", topicsRoot);
	ensureTopic("Topic B", topicsRoot);
	writePortfolio(root, { topics: [{ ...rec({ slug: "topic-a", title: "Topic A" }), lastRunAt: "2020-01-01T00:00:00.000Z" }] });
	writeFileSync(join(a.dir, ".lock"), String(process.pid));
	const { runner, calls } = deferredRunner(topicsRoot);
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 2 }), select: firstFree, decide: breadth, ...quiet });
	await waitFor(() => calls.length === 1, "one run");
	assert.equal(calls[0].args[1], "Topic B");
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(calls.length, 1, "the external run fills the second lane");
	assert.deepEqual(JSON.parse(readFileSync(join(root, "driver.json"), "utf8")).external, [{ slug: "topic-a", pid: process.pid }]);
	const ts = new Date().toISOString();
	appendFileSync(a.runs, JSON.stringify({ event: "start", runId: "r-external", ts, mode: "focus", target: "f-1ea5a953", windows: 2 }) + "\n");
	appendFileSync(a.runs, JSON.stringify({ event: "end", runId: "r-external", ts, exitCode: 0, reason: "complete", findings: 3 }) + "\n");
	rmSync(join(a.dir, ".lock"));
	await waitFor(() => decisions(root).some((d) => d.reconciled), "reconciled decision");
	await waitFor(() => calls.length === 2, "a lane takes the freed slot");
	calls.forEach((c) => c.release());
	await done;
	const r = portfolio(root).topics.find((t: TopicRecord) => t.slug === "topic-a");
	assert.deepEqual(r.deepened, ["f-1ea5a953"]);
	assert.equal(r.runs, 2, "the reconciled run and the lane's own run");
});

test("runPortfolio: startup reconcile applies runs after lastRunAt; a record with no marker applies nothing", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	const x = ensureTopic("Topic X", topicsRoot);
	const y = ensureTopic("Topic Y", topicsRoot);
	for (const [t, id] of [[x, "r-0000000x"], [y, "r-0000000y"]] as const) {
		appendFileSync(t.runs, JSON.stringify({ event: "start", runId: id, ts: "2021-01-01T00:00:00.000Z", mode: "breadth", windows: 1 }) + "\n");
		appendFileSync(t.runs, JSON.stringify({ event: "end", runId: id, ts: "2021-01-01T01:00:00.000Z", exitCode: 0, reason: "complete", findings: 0 }) + "\n");
	}
	writePortfolio(root, { topics: [{ ...rec({ slug: "topic-x", title: "Topic X" }), lastRunAt: "2020-01-01T00:00:00.000Z" }, rec({ slug: "topic-y", title: "Topic Y" })] });
	const stop: Selector = async () => ({ decision: { kind: "stop", reason: "done" }, rationale: "stop" });
	const { runner } = deferredRunner(topicsRoot);
	await runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ maxCycles: 1 }), select: stop, decide: breadth, ...quiet });
	const [rx, ry] = ["topic-x", "topic-y"].map((s) => portfolio(root).topics.find((t: TopicRecord) => t.slug === s));
	assert.deepEqual([rx.lastRunId, rx.runs], ["r-0000000x", 1]);
	assert.deepEqual([ry.lastRunId, ry.runs], ["r-0000000y", 0], "pre-driver history is marked, not counted");
	assert.deepEqual(decisions(root).filter((d) => d.reconciled).map((d) => d.slug), ["topic-x"]);
});

test("runPortfolio lanes: a queued brief is claimed by exactly one lane", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	const body = "## Question\nDoes error-cluster weighting beat class rebalancing on rare-class F1?\n\n## Prior work\nJTT, CReST, and class-balanced loss all touch this; we ask how they compose in a recursive accumulate loop and where novelty remains.\n\n## Method\nSimulate a logistic student and generator in the sandbox across several generations.";
	writeFileSync(join(queueDir, "lead.md"), `# Queued Lead Topic\n\n${body}`);
	const idle: Selector = async () => ({ decision: { kind: "idle", minutes: 1, reason: "nothing" }, rationale: "idle" });
	const { runner, calls } = deferredRunner(topicsRoot);
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 4 }), select: idle, decide: breadth, ...quiet });
	await waitFor(() => calls.length === 1 && decisions(root).length >= 1, "brief started and the other lane idled");
	assert.ok(existsSync(join(queueDir, "active", "lead.md")), "claimed into active/");
	calls[0].release();
	await done;
	assert.equal(calls.length, 1, "exactly one breadth run");
	assert.ok(existsSync(join(queueDir, "done", "lead.md")));
	assert.deepEqual(readdirSync(join(queueDir, "active")), []);
});

test("runPortfolio lanes: a failing lane does not stop the other", async () => {
	const { root, topicsRoot, queueDir } = dirs();
	ensureTopic("Topic A", topicsRoot);
	ensureTopic("Topic B", topicsRoot);
	const { runner, calls } = deferredRunner(topicsRoot, (lane) => lane === 1);
	const done = runPortfolio({ root, runner, topicsRoot, queueDir, cfg: laneCfg({ lanes: 2, maxCycles: 2 }), select: firstFree, decide: breadth, ...quiet });
	await waitFor(() => calls.length === 1, "lane 2 run");
	assert.equal(calls[0].lane, 2);
	calls[0].release();
	await done;
	const ds = decisions(root);
	assert.ok(ds.some((d) => d.lane === 1 && d.rationale === "lane error"));
	assert.ok(ds.some((d) => d.lane === 2 && d.outcome?.reason === "complete"));
});
