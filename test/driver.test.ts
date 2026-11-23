import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAPER, VALID, why } from "./records.ts";
import { appendFinding, appendVerification, readFindings } from "../src/ledger.ts";
import { applyOutcome, DEFAULT_CONFIG, decideNext, type TopicRecord } from "../src/portfolio.ts";
import { runDriver, type Runner } from "../src/driver.ts";
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
