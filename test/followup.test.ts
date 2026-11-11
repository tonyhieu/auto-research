import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendFinding,
	appendVerification,
	createTask,
	listTasks,
	MAX_VERIFY_ATTEMPTS,
	openObjections,
	requeueVerification,
	updateTask,
} from "../src/ledger.ts";
import { promoteToMemory } from "../src/memory.ts";
import { verifierPrompt } from "../src/prompts.ts";
import { ensureTopic } from "../src/topic.ts";
import { taskTools } from "../src/tools.ts";

const base = { author: "a", evidence: "e", sources: ["p"], status: "unverified" as const };
const verdict = (t: { verifications: string }, findingId: string, check: "citation" | "adversarial" | "novelty", v: "pass" | "fail" | "inconclusive") =>
	appendVerification(t.verifications, { findingId, check, verdict: v, rationale: `${check} said ${v}`, sources: ["a", "b", "c", "d", "e"], by: "ver-1" });

function setup() {
	const t = ensureTopic("fu", mkdtempSync(join(tmpdir(), "ar-")));
	const f = appendFinding(t.ledger, { ...base, kind: "insight", claim: "the claim" });
	const vt = createTask(t.tasks, `Verify ${f.id}`, "c", { type: "verify", findingId: f.id });
	updateTask(t.tasks, { ...vt, status: "done" });
	verdict(t, f.id, "citation", "pass");
	verdict(t, f.id, "adversarial", "inconclusive");
	return { t, f };
}

test("inconclusive finding shows up as an objection with only its non-pass checks", () => {
	const { t, f } = setup();
	const os = openObjections(t);
	assert.equal(os.length, 1);
	assert.equal(os[0].finding.id, f.id);
	assert.deepEqual(os[0].open.map((v) => `${v.check}=${v.verdict}`), ["adversarial=inconclusive"]);
});

test("objection disappears while a follow-up task addresses it; finishing it re-queues verification", () => {
	const { t, f } = setup();
	const fu = createTask(t.tasks, "test the objection", "d", { addresses: [f.id] });
	assert.equal(openObjections(t).length, 0, "busy: someone is on it");
	assert.deepEqual(requeueVerification(t, fu), [f.id]);
	assert.deepEqual(requeueVerification(t, fu), [], "not queued twice while one is open");
	const verifies = listTasks(t.tasks).filter((x) => x.type === "verify" && x.findingId === f.id);
	assert.equal(verifies.length, 2);
});

test("re-verification stops at the attempt cap and for settled findings", () => {
	const { t, f } = setup();
	for (let i = 1; i < MAX_VERIFY_ATTEMPTS; i++) {
		const vt = createTask(t.tasks, "v", "c", { type: "verify", findingId: f.id });
		updateTask(t.tasks, { ...vt, status: "done" });
	}
	const fu = createTask(t.tasks, "x", "d", { addresses: [f.id] });
	assert.deepEqual(requeueVerification(t, fu), [], "cap reached");
	assert.equal(openObjections(t).filter((o) => o.finding.id === f.id).length, 0, "capped findings are not shown");

	const s = setup();
	verdict(s.t, s.f.id, "adversarial", "fail"); // refuted = settled
	assert.deepEqual(requeueVerification(s.t, createTask(s.t.tasks, "x", "d", { addresses: [s.f.id] })), []);
	assert.equal(openObjections(s.t).length, 0);
});

test("task_create validates addressed finding ids", async () => {
	const { t, f } = setup();
	const { create } = taskTools(t);
	const call = (p: object) => create.execute("id", p as never, undefined, undefined, {} as never);
	await assert.rejects(() => call({ title: "x", description: "d", addresses: ["f-nope"] }), /Unknown finding id/);
	await call({ title: "x", description: "d", addresses: [f.id] });
	assert.deepEqual(listTasks(t.tasks).find((x) => x.title === "x")?.addresses, [f.id]);
});

test("re-verifier prompt includes earlier verdicts and follow-up tasks", () => {
	const { t, f } = setup();
	const fu = createTask(t.tasks, "test the objection", "d", { addresses: [f.id] });
	const p = verifierPrompt(f, [{ id: "v", ts: "t", findingId: f.id, check: "adversarial", verdict: "inconclusive", rationale: "hidden assumption", sources: [], by: "ver-1" }], [fu]);
	assert.match(p, /RE-VERIFICATION/);
	assert.match(p, /adversarial=inconclusive \(ver-1\): hidden assumption/);
	assert.match(p, new RegExp(`${fu.id}: test the objection`));
	assert.doesNotMatch(verifierPrompt(f), /RE-VERIFICATION/);
});

// Integration with the real pi memory script (~/memory/scripts/add.py) against a temp root.
test("promotion writes verified+novel insights once and a digest, in pi memory format", { skip: !existsSync(join(process.env.HOME ?? "", "memory/scripts/add.py")) }, () => {
	const t = ensureTopic("Promo Topic", mkdtempSync(join(tmpdir(), "ar-")));
	const novel = appendFinding(t.ledger, { ...base, kind: "insight", claim: "novel claim" });
	const known = appendFinding(t.ledger, { ...base, kind: "insight", claim: "known claim" });
	for (const [f, n] of [[novel, "pass"], [known, "fail"]] as const) {
		verdict(t, f.id, "citation", "pass");
		verdict(t, f.id, "adversarial", "pass");
		verdict(t, f.id, "novelty", n);
	}
	const report = join(t.reports, "w1.md");
	writeFileSync(report, "## Verified novel insights\n- novel claim\n");

	const r = promoteToMemory(t, report);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(r.written.sort(), [`promo-topic-${novel.id}`, "promo-topic-digest"].sort());
	const entry = readFileSync(join(t.memory, `promo-topic-${novel.id}.md`), "utf8");
	assert.match(entry, /^---\n[\s\S]*slug: promo-topic-f-[\s\S]*type: research[\s\S]*---/);
	assert.match(entry, /novelty: pass/);
	assert.ok(!existsSync(join(t.memory, `promo-topic-${known.id}.md`)), "known findings are not promoted");
	assert.match(readFileSync(join(t.memory, "promo-topic-digest.md"), "utf8"), /1 novel[\s\S]*## Verified novel insights/);

	assert.deepEqual(promoteToMemory(t).written, [], "insights are written once; no report means no digest");

	// A later refutation archives the entry once, with the reason.
	verdict(t, novel.id, "adversarial", "fail");
	assert.deepEqual(promoteToMemory(t).written, [`promo-topic-${novel.id} (archived)`]);
	const archived = readFileSync(join(t.memory, `promo-topic-${novel.id}.md`), "utf8");
	assert.match(archived, /status: archived[\s\S]*Superseded: this finding is now refuted/);
	assert.deepEqual(promoteToMemory(t).written, [], "archived once");

	// Verified+novel again (e.g. a mistaken refutation corrected): the entry comes back as active.
	verdict(t, novel.id, "adversarial", "pass");
	assert.deepEqual(promoteToMemory(t).written, [`promo-topic-${novel.id}`]);
	assert.match(readFileSync(join(t.memory, `promo-topic-${novel.id}.md`), "utf8"), /status: active/);
	assert.deepEqual(promoteToMemory(t).written, [], "reactivated once");
});
