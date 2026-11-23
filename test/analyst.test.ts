import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../src/ledger.ts";
import { parseAction, validateAction } from "../src/analyst.ts";
import { DEFAULT_CONFIG } from "../src/portfolio.ts";
import { type Decider, runDriver, type Runner } from "../src/driver.ts";
import { ensureTopic, type TopicPaths } from "../src/topic.ts";

const f = (id: string, status: string, novelty?: string): Finding => ({ id, status, novelty, title: id, claim: "c" }) as unknown as Finding;
const ctx = (findings: Finding[]) => ({ findings, cfg: DEFAULT_CONFIG });

test("parseAction returns the last JSON object carrying an action, ignoring prose and earlier blocks", () => {
	const text = 'Here is my reasoning {"note":"not it"}. Final:\n```json\n{"action":{"kind":"breadth","windows":3},"rationale":"explore"}\n```';
	assert.deepEqual(parseAction(text), { action: { kind: "breadth", windows: 3 }, rationale: "explore" });
	assert.equal(parseAction("no json here"), undefined);
});

test("validateAction: breadth defaults windows; unknown kind and missing object are rejected", () => {
	assert.deepEqual(validateAction({ action: { kind: "breadth" } }, ctx([])), { ok: true, action: { kind: "breadth", windows: DEFAULT_CONFIG.windows }, rationale: "" });
	assert.equal(validateAction({ action: { kind: "frobnicate" } }, ctx([])).ok, false);
	assert.equal(validateAction({}, ctx([])).ok, false);
});

test("validateAction: focus needs a known findingId or a bounded hypothesis", () => {
	const findings = [f("f-00000001", "unverified")];
	assert.equal((validateAction({ action: { kind: "focus", findingId: "f-00000001" } }, ctx(findings)) as any).action.findingId, "f-00000001");
	assert.equal(validateAction({ action: { kind: "focus", findingId: "f-deadbeef" } }, ctx(findings)).ok, false, "unknown id rejected");
	assert.equal(validateAction({ action: { kind: "focus" } }, ctx(findings)).ok, false, "needs id or hypothesis");
	assert.equal(validateAction({ action: { kind: "focus", hypothesis: "x".repeat(1001) } }, ctx(findings)).ok, false, "hypothesis cap");
	assert.equal((validateAction({ action: { kind: "focus", hypothesis: "test weights" } }, ctx(findings)) as any).action.hypothesis, "test weights");
});

test("validateAction: preprint only for a verified+novel finding", () => {
	const findings = [f("f-00000001", "verified", "novel"), f("f-00000002", "verified", "known")];
	assert.equal((validateAction({ action: { kind: "preprint", findingId: "f-00000001" } }, ctx(findings)) as any).action.kind, "preprint");
	assert.equal(validateAction({ action: { kind: "preprint", findingId: "f-00000002" } }, ctx(findings)).ok, false, "known is not novel");
	assert.equal(validateAction({ action: { kind: "preprint", findingId: "f-missing0" } }, ctx(findings)).ok, false);
});

test("validateAction: retire needs a reason; idle clamps minutes", () => {
	assert.equal(validateAction({ action: { kind: "retire" } }, ctx([])).ok, false);
	assert.equal((validateAction({ action: { kind: "retire", reason: "mined out" } }, ctx([])) as any).action.reason, "mined out");
	assert.equal((validateAction({ action: { kind: "idle", minutes: 9999, reason: "wait" } }, ctx([])) as any).action.minutes, 240);
});

test("runDriver honors an injected decider and records a retire", async () => {
	const root = mkdtempSync(join(tmpdir(), "ar-portfolio-"));
	const topic: TopicPaths = ensureTopic("Analyst Demo", mkdtempSync(join(tmpdir(), "ar-topics-")));
	const actions = [
		{ action: { kind: "breadth", windows: 1 }, rationale: "explore" },
		{ action: { kind: "retire", reason: "nothing left" }, rationale: "done" },
	];
	let i = 0;
	const decide: Decider = async () => actions[i++] as any;
	const runner: Runner = {
		research: async () => {
			appendFileSync(topic.runs, JSON.stringify({ event: "end", runId: "r-x", ts: new Date().toISOString(), exitCode: 0, reason: "complete", findings: 0 }) + "\n");
			return 0;
		},
		preprint: async () => 0,
	};
	await runDriver({ topic, root, runner, cfg: { ...DEFAULT_CONFIG, maxCycles: 5 }, decide, sleep: async () => {}, log: () => {} });

	const kinds = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action.kind);
	assert.deepEqual(kinds, ["breadth", "retire"]);
	assert.equal(JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8")).topics[0].status, "retired");
});
