import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionOfStart, applyOutcome, DEFAULT_CONFIG, endReason, type TopicRecord, unaccountedRuns } from "../src/portfolio.ts";

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
const start = (runId: string, ts: string, over: object = {}) => ({ event: "start", runId, ts, mode: "breadth", windows: 1, ...over });
const end = (runId: string, ts: string) => ({ event: "end", runId, ts, exitCode: 0, reason: "complete", findings: 0 });
function runsFile(events: object[]): string {
	const f = join(mkdtempSync(join(tmpdir(), "ar-runs-")), "runs.jsonl");
	writeFileSync(f, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return f;
}

test("unaccountedRuns: finished runs after lastRunId, skipping unfinished starts", () => {
	const f = runsFile([start("r-1", "2026-01-01T00:00:00Z"), end("r-1", "2026-01-01T01:00:00Z"), start("r-2", "2026-01-02T00:00:00Z"), start("r-3", "2026-01-03T00:00:00Z"), end("r-3", "2026-01-03T01:00:00Z"), start("r-4", "2026-01-04T00:00:00Z")]);
	assert.deepEqual(unaccountedRuns(f, rec({ lastRunId: "r-1" })).map((p) => p.end.runId), ["r-3"]);
	assert.deepEqual(unaccountedRuns(f, rec({ lastRunId: "r-3" })), []);
	assert.deepEqual(unaccountedRuns(f, rec({ lastRunId: "r-unknown" })), [], "an unknown marker applies nothing");
});

test("unaccountedRuns: without lastRunId, only runs started after lastRunAt; with neither, nothing", () => {
	const f = runsFile([start("r-1", "2026-01-01T00:00:00Z"), end("r-1", "2026-01-01T01:00:00Z"), start("r-2", "2026-01-02T00:00:00Z"), end("r-2", "2026-01-02T01:00:00Z")]);
	assert.deepEqual(unaccountedRuns(f, rec({ lastRunAt: "2026-01-01T01:00:00Z" })).map((p) => p.start.runId), ["r-2"]);
	assert.deepEqual(unaccountedRuns(f, rec()), []);
	assert.deepEqual(unaccountedRuns(join(tmpdir(), "missing-runs.jsonl"), rec({ lastRunAt: "2020-01-01T00:00:00Z" })), []);
});

test("actionOfStart: breadth, focus on a finding id, or focus on a hypothesis", () => {
	assert.deepEqual(actionOfStart(start("r", "t", { windows: 3 }) as any), { kind: "breadth", windows: 3 });
	assert.deepEqual(actionOfStart(start("r", "t", { mode: "focus", target: "f-1ea5a953", windows: 2 }) as any), { kind: "focus", findingId: "f-1ea5a953", windows: 2 });
	assert.deepEqual(actionOfStart(start("r", "t", { mode: "focus", target: "Paraphrase copies help" }) as any), { kind: "focus", hypothesis: "Paraphrase copies help", windows: 1 });
});

test("endReason: a complete run that launched no agents is empty; older events without a count stay complete", () => {
	const end = { event: "end" as const, runId: "r-1", ts: "t", exitCode: 0, findings: 3 };
	assert.equal(endReason({ ...end, reason: "complete", agents: 0 }), "empty");
	assert.equal(endReason({ ...end, reason: "complete", agents: 4 }), "complete");
	assert.equal(endReason({ ...end, reason: "complete" }), "complete");
	assert.equal(endReason({ ...end, reason: "signal", agents: 0 }), "signal");
});

test("applyOutcome: an empty run counts as a run but is no evidence about the topic", () => {
	const r = rec({ consecutiveFocus: 1, consecutiveBarrenRuns: 1 });
	applyOutcome(r, { action: { kind: "focus", findingId: "f-1", windows: 2 }, vnBefore: ["f-1"], vnAfter: ["f-1"], reason: "empty", ts: "t" }, { ...DEFAULT_CONFIG, barrenLimit: 1 });
	assert.deepEqual([r.runs, r.lastReason, r.deepened, r.consecutiveFocus, r.consecutiveBarrenRuns, r.consecutiveErrors ?? 0, r.status], [1, "empty", [], 1, 1, 0, "active"]);
});
