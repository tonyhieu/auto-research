import { test } from "node:test";
import assert from "node:assert/strict";
import { PAPER, VALID, why } from "./records.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFinding, appendVerification, createTask, readFindings, readVerifications, updateTask } from "../src/ledger.ts";
import { resolveFocus } from "../src/focus.ts";
import { focusOrchestratorSystem, verifierPrompt } from "../src/prompts.ts";
import { CLAIM_MAX, claimErrors } from "../src/schema.ts";
import { ensureTopic, REPO_ROOT } from "../src/topic.ts";
import { BASE_CHECKS, focusVerdictTool, ledgerTools, verifyTool } from "../src/tools.ts";

const exported = (name: string) => JSON.parse(readFileSync(join(REPO_ROOT, "schema", `${name}.schema.json`), "utf8"));
/** Plain JSON view of a tool's parameters (drops TypeBox's symbol keys). */
const json = (x: unknown) => JSON.parse(JSON.stringify(x));
const topic = (name: string) => ensureTopic(name, mkdtempSync(join(tmpdir(), "ar-")));
const finding = { ...VALID, author: "a", kind: "insight" as const, claim: "A claim long enough to be valid", status: "unverified" as const };
const verdict = { check: "citation" as const, verdict: "pass" as const, rationale: why("ok"), sources: [], by: "ver" };

test("appendFinding rejects records that break the schema and writes nothing", () => {
	const t = topic("sf");
	const bad: [string, object][] = [
		["title", { title: undefined }],
		["claim", { claim: "two\nlines are not one atomic claim" }],
		["evidence", { evidence: "short" }],
		["sources/0", { sources: ["not-an-id"] }],
		["sources", { sources: [] }],
		["experiment/setup", { experiment: { setup: "short", results: "| a |\n|---|\n| 1 |" } }],
		["novelty", { novelty: "novel" }],
	];
	for (const [path, over] of bad) assert.throws(() => appendFinding(t.ledger, { ...finding, ...over } as never), new RegExp(`invalid finding: /${path}`), path);
	assert.equal(readFindings(t.ledger).length, 0);
	const ok = appendFinding(t.ledger, { ...finding, experiment: { setup: "Setup with data, model, and seeds: enough to rerun.", results: "| seed | acc |\n|---|---|\n| 0 | 0.9 |" } });
	assert.deepEqual(readFindings(t.ledger), [ok]);
});

test("appendVerification rejects records that break the schema and accepts a focus outcome", () => {
	const t = topic("sv");
	const bad: [string, object][] = [
		["rationale", { rationale: "r" }],
		["sources/0", { sources: ['["0123"]'] }],
		["focus/key", { focus: { key: "fx-nope", outcome: "holds" } }],
		["focus/outcome", { focus: { key: "fx-0123abcd", outcome: "partly" } }],
	];
	for (const [path, over] of bad) {
		assert.throws(() => appendVerification(t.verifications, { ...verdict, findingId: "f-0123abcd", ...over } as never), new RegExp(`invalid verification: /${path}`), path);
	}
	assert.equal(readVerifications(t.verifications).length, 0);
	appendVerification(t.verifications, { ...verdict, findingId: "f-0123abcd", focus: { key: "fx-0123abcd", outcome: "holds_with_limits", narrowedFindingId: "f-4567cdef" } });
	assert.equal(readVerifications(t.verifications)[0].focus?.outcome, "holds_with_limits");
});

test("ledger_add parameters are the exported FindingInput schema", async () => {
	const t = topic("sa");
	const { add } = ledgerTools(t, "sub-1", "t-0123abcd");
	assert.deepEqual(json(add.parameters), exported("finding-input"));
	await add.execute("id", { kind: "gap", title: "No paper does X", claim: "No paper among those checked does X.", evidence: VALID.evidence, experiment: null, sources: [PAPER] } as never, undefined, undefined, {} as never);
	const [f] = readFindings(t.ledger);
	assert.deepEqual([f.author, f.taskId, f.title, "experiment" in f], ["sub-1", "t-0123abcd", "No paper does X", false]);
});

test("verify_record parameters are the exported VerdictInput schema with checks narrowed per mode", async () => {
	const t = topic("sr");
	const f = appendFinding(t.ledger, finding);
	const params = (checks?: typeof BASE_CHECKS) => json(verifyTool(t, f.id, "ver", () => 0, checks).parameters);
	const schema = exported("verdict-input");
	assert.deepEqual(params(), { ...schema, properties: { ...schema.properties, check: { ...schema.properties.check, enum: BASE_CHECKS } } });
	assert.deepEqual(params([...BASE_CHECKS, "reproduce"]).properties.check.enum, ["citation", "adversarial", "novelty", "reproduce"]);
	assert.deepEqual(schema.properties.check.enum, ["citation", "adversarial", "novelty", "reproduce"], "the exported schema is not mutated");
	// sources may be omitted, as in the schema.
	await verifyTool(t, f.id, "ver", () => 0).execute("id", { check: "adversarial", verdict: "pass", rationale: why("held") } as never, undefined, undefined, {} as never);
	assert.deepEqual(readVerifications(t.verifications)[0].sources, []);
});

test("focus_verdict needs titles and links the narrowed finding in the verdict's focus field", async () => {
	const t = topic("sfv");
	const target = appendFinding(t.ledger, finding);
	const refuter = appendFinding(t.ledger, { ...finding, kind: "gap" });
	for (const check of ["citation", "adversarial"] as const) appendVerification(t.verifications, { ...verdict, check, findingId: refuter.id });
	const focus = resolveFocus(t, target.id);
	writeFileSync(focus.state, "## Claim tree\nC1 refuted\n## Verdict\nholds with limits");
	updateTask(t.tasks, { ...createTask(t.tasks, "C1 test", "d", { focus: focus.key }), status: "done" });
	const tool = focusVerdictTool(t, focus);
	const params = json(tool.parameters).properties;
	assert.equal(params.narrowedClaim.maxLength, CLAIM_MAX);
	assert.equal(params.narrowedClaim.pattern, exported("finding-input").properties.claim.pattern);
	const p = { outcome: "holds_with_limits", summary: why("C1 refuted"), narrowedClaim: "The claim holds only for small n.", sources: [PAPER], refutedBy: [refuter.id] };
	const call = (x: object) => tool.execute("id", x as never, undefined, undefined, {} as never);
	await assert.rejects(() => call(p), /narrowedTitle/);
	assert.equal(readFindings(t.ledger).length, 2, "nothing written");
	await call({ ...p, narrowedTitle: "Holds for small n" });
	const narrowed = readFindings(t.ledger).find((f) => f.title === "Holds for small n")!;
	const v = readVerifications(t.verifications).find((x) => x.by === `focus-${focus.key}`);
	assert.deepEqual(v?.focus, { key: focus.key, outcome: "holds_with_limits", narrowedFindingId: narrowed.id });

	// A free-text target becomes a finding, so it needs a title too.
	const free = resolveFocus(t, "A free-text hypothesis about X");
	writeFileSync(free.state, "## Verdict\nholds");
	updateTask(t.tasks, { ...createTask(t.tasks, "x", "d", { focus: free.key }), status: "done" });
	const held = { outcome: "holds", summary: why("All sub-claims held"), sources: [PAPER] };
	await assert.rejects(() => focusVerdictTool(t, free).execute("id", held as never, undefined, undefined, {} as never), /targetTitle/);
	await focusVerdictTool(t, free).execute("id", { ...held, targetTitle: "Hypothesis about X" } as never, undefined, undefined, {} as never);
	const ft = readFindings(t.ledger).find((f) => f.claim === free.target);
	assert.deepEqual([ft?.title, ft?.role], ["Hypothesis about X", "focus-target"]);
	assert.deepEqual(readVerifications(t.verifications).find((x) => x.by === `focus-${free.key}`)?.focus, { key: free.key, outcome: "holds" });
});

test("verifier and focus prompts show the title and experiment", () => {
	const t = topic("sp");
	const f = appendFinding(t.ledger, { ...finding, title: "Short headline", experiment: { setup: "SETUP: three seeds, n=100, logistic regression.", results: "RESULTS table: acc 0.91 +- 0.02" } });
	assert.match(verifierPrompt(f), /Title: Short headline[\s\S]*Experiment setup: SETUP[\s\S]*Experiment results: RESULTS table/);
	const focus = resolveFocus(t, f.id);
	assert.match(focusOrchestratorSystem(t, focus, f), /Title: Short headline\nClaim: [\s\S]*Experiment setup: SETUP[\s\S]*Experiment results: RESULTS table/);
});

test("claimErrors: a free-text focus target must fit the claim schema", () => {
	assert.deepEqual(claimErrors("A hypothesis that fits on one line"), []);
	assert.equal(claimErrors("x".repeat(CLAIM_MAX + 1)).length, 1);
	assert.equal(claimErrors("two\nlines here, long enough").length, 1);
});

test("cli rejects a free-text -f over the claim limit before taking the lock", () => {
	const title = `zz cli focus ${process.pid}`;
	const dir = join(REPO_ROOT, "topics", title.replace(/ /g, "-"));
	try {
		const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "-t", title, "-f", "x".repeat(CLAIM_MAX + 1)], {
			cwd: REPO_ROOT,
			env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "ar-home-")) },
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.equal(r.status, 2);
		assert.match(r.stderr, /-f hypothesis cannot be a finding claim: .*1000/);
		assert.ok(!existsSync(join(dir, "state", "runs.jsonl")), "no run started");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
