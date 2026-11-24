import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforce, lockExists } from "../src/guardrails.ts";
import { ensureTopic } from "../src/topic.ts";
import { DEFAULT_CONFIG, type TopicRecord } from "../src/portfolio.ts";

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

test("enforce: a locked topic turns a run into idle", () => {
	const g = enforce({ kind: "breadth", windows: 2 }, rec(), DEFAULT_CONFIG, { locked: true });
	assert.equal(g.action.kind, "idle");
	assert.equal(g.note, "locked");
});

test("enforce: focus past the consecutive cap becomes breadth", () => {
	const g = enforce({ kind: "focus", findingId: "f-00000001", windows: 2 }, rec({ consecutiveFocus: DEFAULT_CONFIG.maxConsecutiveFocus }), DEFAULT_CONFIG, { docker: true });
	assert.deepEqual(g.action, { kind: "breadth", windows: 2 });
	assert.match(g.note ?? "", /focus cap/);
});

test("enforce: focus with no sandbox falls back to breadth", () => {
	const g = enforce({ kind: "focus", findingId: "f-00000001", windows: 1 }, rec(), DEFAULT_CONFIG, { docker: false });
	assert.deepEqual(g.action, { kind: "breadth", windows: 1 });
	assert.match(g.note ?? "", /docker/);
});

test("enforce: within limits the action passes through unchanged", () => {
	const a = { kind: "preprint", findingId: "f-00000001" } as const;
	const g = enforce(a, rec({ deepened: ["f-00000001"] }), DEFAULT_CONFIG, { locked: false, docker: true });
	assert.equal(g.action, a);
	assert.equal(g.note, undefined);
});

test("lockExists: a live pid counts; a crashed run's stale lock does not", () => {
	const topic = ensureTopic("Lock Demo", mkdtempSync(join(tmpdir(), "ar-topics-")));
	assert.equal(lockExists(topic), false);
	writeFileSync(join(topic.dir, ".lock"), String(process.pid));
	assert.equal(lockExists(topic), true);
	writeFileSync(join(topic.dir, ".lock"), "99999999");
	assert.equal(lockExists(topic), false);
});

test("enforce: no retiring right after an empty run; it says nothing about the topic", () => {
	const g = enforce({ kind: "retire", reason: "last window ran nothing" }, rec({ lastReason: "empty" }), DEFAULT_CONFIG);
	assert.equal(g.action.kind, "idle");
	assert.match(g.note ?? "", /empty/);
	assert.equal(enforce({ kind: "retire", reason: "done" }, rec({ lastReason: "complete" }), DEFAULT_CONFIG).action.kind, "retire");
});
