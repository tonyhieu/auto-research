import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendFinding,
	claimNextTask,
	createTask,
	enqueueVerifyTasks,
	listTasks,
	loadFindings,
	type Finding,
	type Verification,
	applyVerifications,
	appendVerification,
	updateTask,
} from "../src/ledger.ts";
import { ensureTopic } from "../src/topic.ts";
import { focusVerdictTool, verifyTool } from "../src/tools.ts";
import { resolveFocus, scopeProblems } from "../src/focus.ts";

const F: Finding = { id: "f1", ts: "t0", author: "a", claim: "c", evidence: "e", sources: ["p"], status: "unverified", kind: "insight" };
const v = (check: Verification["check"], verdict: Verification["verdict"], ts: string): Verification => ({
	id: `v-${ts}`, ts, findingId: "f1", check, verdict, rationale: "", sources: [], by: "ver",
});
const derive = (...vs: Verification[]) => applyVerifications([F], vs)[0];

test("status: citation+adversarial pass verifies; either failing refutes; novelty is separate", () => {
	assert.equal(derive().status, "unverified");
	assert.equal(derive(v("citation", "pass", "1")).status, "unverified", "one check is not enough");
	const ok = derive(v("citation", "pass", "1"), v("adversarial", "pass", "2"), v("novelty", "pass", "3"));
	assert.deepEqual([ok.status, ok.novelty], ["verified", "novel"]);
	const known = derive(v("citation", "pass", "1"), v("adversarial", "pass", "2"), v("novelty", "fail", "3"));
	assert.deepEqual([known.status, known.novelty], ["verified", "known"], "known is still true");
	assert.equal(derive(v("citation", "pass", "1"), v("adversarial", "fail", "2")).status, "refuted");
	assert.equal(derive(v("citation", "fail", "1"), v("adversarial", "pass", "2")).status, "refuted");
	assert.equal(derive(v("adversarial", "inconclusive", "1"), v("citation", "pass", "2")).status, "unverified");
});

test("latest verdict per check wins regardless of file order", () => {
	assert.equal(derive(v("adversarial", "pass", "3"), v("citation", "pass", "1"), v("adversarial", "fail", "2")).status, "verified");
});

test("verify tasks: one per gap/insight (incl. legacy unkinded), never for literature, never twice", () => {
	const t = ensureTopic("vq", mkdtempSync(join(tmpdir(), "ar-")));
	const base = { author: "a", evidence: "e", sources: ["p"], status: "unverified" as const };
	appendFinding(t.ledger, { ...base, kind: "literature", claim: "lit" });
	const gap = appendFinding(t.ledger, { ...base, kind: "gap", claim: "gap" });
	const legacy = appendFinding(t.ledger, { ...base, claim: "old" });
	assert.equal(enqueueVerifyTasks(t), 2);
	assert.equal(enqueueVerifyTasks(t), 0, "idempotent");
	const ids = listTasks(t.tasks).map((x) => x.findingId).sort();
	assert.deepEqual(ids, [gap.id, legacy.id].sort());
});

test("claim order: verify tasks before older research; allow filter restricts", () => {
	const t = ensureTopic("vc", mkdtempSync(join(tmpdir(), "ar-")));
	createTask(t.tasks, "research", "d");
	createTask(t.tasks, "verify", "d", { type: "verify", findingId: "f1" });
	assert.equal(claimNextTask(t.tasks, "x")?.type, "verify");
	assert.equal(claimNextTask(t.tasks, "x", (x) => x.type === "verify"), undefined, "research filtered out");
	assert.equal(claimNextTask(t.tasks, "x")?.title, "research");
});

test("verify_record: bound to one finding; novelty pass needs enough papers", async () => {
	const t = ensureTopic("vr", mkdtempSync(join(tmpdir(), "ar-")));
	const f = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "c", evidence: "e", sources: ["p"], status: "unverified" });
	let searches = 0;
	const tool = verifyTool(t, f.id, "ver-1", () => searches);
	const call = (p: object) => tool.execute("id", p as never, undefined, undefined, {} as never);
	// Any novelty verdict, even inconclusive, is refused until the verifier has searched.
	await assert.rejects(() => call({ check: "novelty", verdict: "inconclusive", rationale: "r", sources: [] }), /at least 3 paper_search calls/);
	await call({ check: "citation", verdict: "inconclusive", rationale: "other checks unaffected", sources: [] });
	searches = 3;
	await assert.rejects(() => call({ check: "novelty", verdict: "pass", rationale: "r", sources: ["a", "b", "a"] }), /at least 5/);
	await call({ check: "novelty", verdict: "pass", rationale: "q1 q2 q3", sources: ["a", "b", "c", "d", "e"] });
	await call({ check: "citation", verdict: "pass", rationale: "ok", sources: ["p"] });
	await call({ check: "adversarial", verdict: "pass", rationale: "survived", sources: [] });
	const got = loadFindings(t).find((x) => x.id === f.id);
	assert.deepEqual([got?.status, got?.novelty], ["verified", "novel"]);
});

test("reproduce: absent is neutral, must pass when recorded, and a failed rerun refutes", () => {
	const base = [v("citation", "pass", "1"), v("adversarial", "pass", "2")];
	assert.equal(derive(...base).status, "verified");
	assert.equal(derive(...base, v("reproduce", "inconclusive", "3")).status, "unverified");
	assert.equal(derive(...base, v("reproduce", "fail", "3")).status, "refuted");
	assert.equal(derive(...base, v("reproduce", "pass", "3")).status, "verified");
	// Gaps and literature have nothing to rerun, so a stray reproduce verdict is ignored.
	const gap = applyVerifications([{ ...F, kind: "gap" }], [...base, v("reproduce", "inconclusive", "3")])[0];
	assert.equal(gap.status, "verified");
});

test("focus: same target reuses its key and state; verify tasks scoped to the focus run's findings", () => {
	const t = ensureTopic("fx", mkdtempSync(join(tmpdir(), "ar-")));
	const a = resolveFocus(t, "hypothesis A");
	assert.equal(resolveFocus(t, "hypothesis A").key, a.key);
	assert.notEqual(resolveFocus(t, "hypothesis B").key, a.key);
	assert.equal(a.findingId, undefined);
	assert.equal(resolveFocus(t, "f-0123abcd").findingId, "f-0123abcd");
	const base = { author: "a", kind: "insight" as const, evidence: "e", sources: ["p"], status: "unverified" as const };
	const ft = createTask(t.tasks, "C1 replicate", "d", { focus: a.key });
	const mine = appendFinding(t.ledger, { ...base, claim: "mine", taskId: ft.id });
	appendFinding(t.ledger, { ...base, claim: "breadth" });
	assert.equal(enqueueVerifyTasks(t, a.key), 1);
	const vt = listTasks(t.tasks).find((x) => x.type === "verify");
	assert.deepEqual([vt?.findingId, vt?.focus], [mine.id, a.key]);
	assert.equal(enqueueVerifyTasks(t), 1, "breadth still covers its own backlog");
});

test("verify_record: a reproduce pass or fail needs the verifier's own python_run", async () => {
	const t = ensureTopic("vrp", mkdtempSync(join(tmpdir(), "ar-")));
	const f = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "c", evidence: "e", sources: ["p"], status: "unverified" });
	let runs = 0;
	const tool = verifyTool(t, f.id, "ver-1", () => 0, ["citation", "adversarial", "novelty", "reproduce"], () => runs);
	const call = (p: object) => tool.execute("id", p as never, undefined, undefined, {} as never);
	await assert.rejects(() => call({ check: "reproduce", verdict: "pass", rationale: "relied on f-x", sources: [] }), /own python_run/);
	await call({ check: "reproduce", verdict: "inconclusive", rationale: "too underspecified", sources: [] });
	runs = 1;
	await call({ check: "reproduce", verdict: "pass", rationale: "reran", sources: [] });
});

test("focus_verdict: refutes the target, records the narrowed claim with a verify task, once per run", async () => {
	const t = ensureTopic("fv", mkdtempSync(join(tmpdir(), "ar-")));
	const base = { author: "a", kind: "insight" as const, evidence: "e", sources: ["p"], status: "unverified" as const };
	const target = appendFinding(t.ledger, { ...base, claim: "big claim" });
	const focus = resolveFocus(t, target.id);
	writeFileSync(focus.state, "## Claim tree\nC1 reproduced\n## Verdict\nholds with limits");
	let hits = 0;
	const tool = focusVerdictTool(t, focus, () => hits++);
	const call = (p: object) => tool.execute("id", p as never, undefined, undefined, {} as never);
	await assert.rejects(() => call({ outcome: "holds", summary: "s", sources: ["p"] }), /No research task has finished/);
	updateTask(t.tasks, { ...createTask(t.tasks, "C1 test", "d", { focus: focus.key }), status: "done" });
	await assert.rejects(() => call({ outcome: "holds_with_limits", summary: "s", sources: ["f-x"] }), /narrowedClaim/);
	await assert.rejects(() => call({ outcome: "holds_with_limits", summary: "s", narrowedClaim: "n", sources: ["p"] }), /needs refutedBy/);
	const pending = appendFinding(t.ledger, { ...base, claim: "unsettled" });
	await assert.rejects(
		() => call({ outcome: "fails", summary: "s", sources: ["p"], refutedBy: [pending.id, target.id] }),
		new RegExp(`not settled or unknown: ${pending.id}\\.`),
	);
	const refuter = appendFinding(t.ledger, { ...base, kind: "gap", claim: "C3 refuted" });
	for (const c of ["citation", "adversarial"] as const) appendVerification(t.verifications, { findingId: refuter.id, check: c, verdict: "pass", rationale: "", sources: [], by: "v" });
	await call({ outcome: "holds_with_limits", summary: "C3 refuted", narrowedClaim: "small claim", sources: ["f-x"], refutedBy: [refuter.id] });
	await assert.rejects(() => call({ outcome: "holds", summary: "s", sources: ["p"] }), /already recorded/);
	const fs = loadFindings(t);
	assert.equal(fs.find((f) => f.id === target.id)?.status, "refuted");
	const narrowed = fs.find((f) => f.claim === "small claim")!;
	assert.equal(narrowed.author, `focus-${focus.key}`);
	const vt = listTasks(t.tasks).find((x) => x.findingId === narrowed.id);
	assert.deepEqual([vt?.type, vt?.focus], ["verify", focus.key]);
	assert.equal(hits, 1);
	// A free-text hypothesis becomes a finding so the verdict has somewhere to go.
	assert.equal(narrowed.kind, "insight", "inherits the target's kind");
	const ft = resolveFocus(t, "free text");
	writeFileSync(ft.state, "## Verdict\nfails");
	updateTask(t.tasks, { ...createTask(t.tasks, "x", "d", { focus: ft.key }), status: "done" });
	await focusVerdictTool(t, ft, () => {}).execute("id", { outcome: "fails", summary: "no", sources: ["p"], refutedBy: [refuter.id] } as never, undefined, undefined, {} as never);
	assert.equal(loadFindings(t).find((f) => f.claim === "free text")?.status, "refuted");
});

test("focus_verdict: a narrowed gap stays a gap", async () => {
	const t = ensureTopic("fg", mkdtempSync(join(tmpdir(), "ar-")));
	const base = { author: "a", evidence: "e", sources: ["p"], status: "unverified" as const };
	const gap = appendFinding(t.ledger, { ...base, kind: "gap", claim: "no paper does X or Y" });
	const refuter = appendFinding(t.ledger, { ...base, kind: "literature", claim: "paper P does X" });
	for (const c of ["citation", "adversarial"] as const) appendVerification(t.verifications, { findingId: refuter.id, check: c, verdict: "pass", rationale: "", sources: [], by: "v" });
	const focus = resolveFocus(t, gap.id);
	writeFileSync(focus.state, "## Verdict\nholds with limits");
	updateTask(t.tasks, { ...createTask(t.tasks, "prior work", "d", { focus: focus.key }), status: "done" });
	await focusVerdictTool(t, focus, () => {}).execute(
		"id",
		{ outcome: "holds_with_limits", summary: "X is done by P", narrowedClaim: "no paper does Y", sources: ["p"], refutedBy: [refuter.id] } as never,
		undefined,
		undefined,
		{} as never,
	);
	assert.equal(loadFindings(t).find((f) => f.claim === "no paper does Y")?.kind, "gap");
});

test("scope: untested items need an allowed reason tag", () => {
	const state = `## Claim tree
- C1 mechanism: reproduced (f-1)
- C2 kernel normalization: out of scope [needs-full-text]
- C3 drift under accumulate: out of scope (future work)
## Verdict
holds
## Open questions
- Run at LLM scale [needs-real-llm]
- Accumulate drift law (left for later)
## Epoch log
- E1: out of scope note in the log is ignored`;
	assert.deepEqual(scopeProblems(state), ["- C3 drift under accumulate: out of scope (future work)", "- Accumulate drift law (left for later)"]);
	assert.deepEqual(scopeProblems("## Claim tree\n- C1 reproduced\n## Verdict\nholds"), []);
});

test("focus_verdict: refuses without a saved verdict, or with untagged untested items", async () => {
	const t = ensureTopic("fs", mkdtempSync(join(tmpdir(), "ar-")));
	const focus = resolveFocus(t, "free text");
	updateTask(t.tasks, { ...createTask(t.tasks, "x", "d", { focus: focus.key }), status: "done" });
	const call = () =>
		focusVerdictTool(t, focus, () => {}).execute("id", { outcome: "holds", summary: "s", sources: ["p"] } as never, undefined, undefined, {} as never);
	await assert.rejects(call, /before calling focus_verdict/);
	writeFileSync(focus.state, "## Claim tree\n- C1 out of scope (future work)\n## Verdict\nholds");
	await assert.rejects(call, /left untested without an allowed reason[\s\S]*C1 out of scope \(future work\)/);
	writeFileSync(focus.state, "## Claim tree\n- C1 out of scope [needs-gpu]\n## Verdict\nholds");
	await call();
});
