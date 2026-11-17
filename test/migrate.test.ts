import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverageError } from "../src/agent.ts";
import { readFindings, readVerifications, type Finding } from "../src/ledger.ts";
import { ADD_PY } from "../src/memory.ts";
import { assertFinding, assertVerification, type FindingInput } from "../src/schema.ts";
import { ensureTopic } from "../src/topic.ts";
import { contentProblems, migrate, normalizeSources, submitTool, type Reformat } from "../scripts/migrate-ledger.ts";
import { PAPER, PAPERS } from "./records.ts";

const hex = (n: number) => n.toString(16).padStart(8, "0");
const fid = (n: number) => `f-${hex(n)}`;

/** A pre-v2 topic: findings without titles, verification sources as JSON strings, focus outcomes only in rationale text. */
function legacyTopic() {
	const root = mkdtempSync(join(tmpdir(), "ar-mig-"));
	const t = ensureTopic("Mig Topic", root);
	const f = (n: number, extra: object = {}) => ({
		id: fid(n), ts: `2026-01-01T00:00:0${n}Z`, author: "sub-1", taskId: `t-${hex(n)}`, kind: "insight",
		claim: `Claim ${n} is long enough to be valid and cites ${fid(5)}.`, evidence: `Evidence for ${n}: acc 0.91 over 3 seeds, see ${PAPER}.`,
		sources: [PAPER, fid(5)], status: "unverified", ...extra,
	});
	// 1 novel, 2 inconclusive, 3 unchecked: kept. 4 known, 5 refuted, 6 unverified: deleted.
	const findings = [f(1), f(2, { role: "focus-target" }), f(3, { kind: "gap", claim: "x".repeat(1200) }), f(4), f(5), f(6)];
	writeFileSync(t.ledger, findings.map((x) => JSON.stringify(x)).join("\n") + "\n");
	let n = 0;
	const v = (findingId: string, check: string, verdict: string, extra: object = {}) => ({
		id: `v-${hex(++n)}`, ts: `2026-01-02T00:00:${String(n).padStart(2, "0")}Z`, findingId, check, verdict,
		rationale: "A rationale that is long enough for the schema minimum.", sources: [], by: "ver", ...extra,
	});
	const pass = (id: string) => [v(id, "citation", "pass"), v(id, "adversarial", "pass")];
	const vs = [
		...pass(fid(1)), v(fid(1), "novelty", "pass", { sources: [`["${PAPERS[0]}","${PAPERS[1]}"]`, "", "2412.19543", `ForTIFAI-${PAPERS[2]}`, "f-0000000a,f-0000000b", "579b55f939"] }),
		...pass(fid(2)), v(fid(2), "novelty", "inconclusive"),
		v(fid(2), "adversarial", "pass", { rationale: "Focus fx-0123abcd verdict: holds. All sub-claims held up under testing.", by: "focus-fx-0123abcd" }),
		...pass(fid(3)),
		...pass(fid(4)), v(fid(4), "novelty", "fail"),
		v(fid(5), "citation", "fail"),
	];
	writeFileSync(t.verifications, vs.map((x) => JSON.stringify(x)).join("\n") + "\n");
	return { root, t };
}

/** Fake agent: titles each finding and shortens over-long claims, keeping content otherwise. */
const fake = (calls: string[], fail = new Set<string>()): Reformat => async (f) => {
	calls.push(f.id);
	if (fail.has(f.id)) return undefined;
	// kind and sources from the agent are ignored; the originals are copied.
	return { kind: "literature", title: `Title of ${f.id}`, claim: f.claim.slice(0, 1000), evidence: `- ${f.evidence}`, experiment: null, sources: [PAPERS[4]] };
};

test("normalizeSources decodes JSON arrays, splits lists, prefixes arXiv ids, and drops what is not an id", () => {
	assert.deepEqual(normalizeSources([`["${PAPERS[0]}"]`, "", "[]", "2412.19543", `ForTIFAI-${PAPERS[1]}`, "f-0000000a, f-0000000b", "579b55f939", PAPERS[0]]), {
		sources: [PAPERS[0], "arXiv:2412.19543", PAPERS[1], "f-0000000a", "f-0000000b"],
		dropped: ["579b55f939"],
	});
});

test("contentProblems flags lost or added ids and new numbers", () => {
	const orig = { claim: "X beats Y by 0.12 (f-0000000a).", evidence: `n=3 seeds; ${PAPER}`, sources: [PAPER, "f-0000000b"] } as Finding;
	const p = (claim: string, evidence = `- n=3 seeds; ${PAPER}`) => ({ kind: "insight", title: "X beats Y", claim, evidence, sources: [] }) as FindingInput;
	assert.deepEqual(contentProblems(orig, p("X beats Y by 0.12 (f-0000000a).")), []);
	assert.deepEqual(contentProblems(orig, p("X beats Y by 0.12 (f-0000000a, f-0000000b).", `| n | ${PAPER} |`)), [], "a cited source id may move into the text");
	const bad = contentProblems(orig, p("X beats Y by 0.13 (f-0000000c)."));
	assert.equal(bad.length, 3);
	assert.match(bad.join("\n"), /missing from the rewrite: f-0000000a[\s\S]*not in the original: f-0000000c[\s\S]*numbers not in the original.*0\.13/);
});

test("submit_finding rejects changed content so the agent retries", async () => {
	const orig = { claim: "X beats Y by 0.12 on the benchmark.", evidence: "acc 0.91 over 3 seeds", sources: [PAPER] } as Finding;
	const got: FindingInput[] = [];
	const tool = submitTool(orig, (p) => got.push(p));
	const p = { kind: "insight", title: "X beats Y", claim: orig.claim, evidence: "- acc 0.91 over 3 seeds", experiment: null, sources: [PAPER] };
	const call = (x: object) => tool.execute("id", x as never, undefined, undefined, {} as never);
	await assert.rejects(() => call({ ...p, evidence: "- acc 0.95 over 3 seeds" }), /0\.95/);
	assert.equal(got.length, 0, "nothing submitted");
	await call(p);
	assert.deepEqual(got.map((x) => x.title), ["X beats Y"]);
});

test("migrate previews without touching the ledger, then applies the reviewed preview", async () => {
	const { root, t } = legacyTopic();
	const before = readFileSync(t.ledger, "utf8");
	const calls: string[] = [];
	const r = await migrate({ root, slug: t.slug, apply: false, reformat: fake(calls) });
	assert.deepEqual(r.selection.keep.map((f) => f.id), [fid(1), fid(2), fid(3)]);
	assert.deepEqual(r.selection.deleted, { unverified: [fid(6)], refuted: [fid(5)], known: [fid(4)] });
	assert.deepEqual([r.failed, r.invalid], [[], []]);
	assert.equal(readFileSync(t.ledger, "utf8"), before, "preview changes nothing");
	assert.equal(readFileSync(join(t.dir, "ledger.pre-v2.jsonl"), "utf8"), before);
	assert.ok(!existsSync(join(t.dir, ".lock")), "lock released");
	assert.match(readFileSync(join(t.dir, "migration.v2-preview.md"), "utf8"), /Kept 3 findings[\s\S]*unverified 1, refuted 1, known \(novelty fail\) 1[\s\S]*Verifications kept 9 of 13[\s\S]*over 1000: 1\. After: .*over 1000: 0/);

	const preview = readFindings(join(t.dir, "ledger.v2-preview.jsonl"));
	const [f1, f2, f3] = preview;
	assert.deepEqual([f1.title, f1.kind, f1.sources, f1.taskId], [`Title of ${fid(1)}`, "insight", [PAPER, fid(5)], `t-${hex(1)}`], "only content comes from the agent");
	assert.deepEqual([f2.role, f3.kind, f3.claim.length], ["focus-target", "gap", 1000]);

	// An old-format memory entry of a kept novel finding is rewritten with the new title.
	const entry = join(t.memory, `${t.slug}-${fid(1)}.md`);
	writeFileSync(entry, "---\nstatus: active\n---\nold entry\n");

	// --apply reuses the preview, so no new agent calls.
	await migrate({ root, slug: t.slug, apply: true, reformat: fake(calls) });
	assert.deepEqual(calls, [fid(1), fid(2), fid(3)]);
	const ledger = readFindings(t.ledger);
	assert.deepEqual(ledger, preview);
	for (const f of ledger) assertFinding(f);
	const vs = readVerifications(t.verifications);
	for (const v of vs) assertVerification(v);
	assert.ok(vs.every((v) => [fid(1), fid(2), fid(3)].includes(v.findingId)));
	assert.deepEqual(vs.find((v) => v.check === "novelty" && v.findingId === fid(1))?.sources, [PAPERS[0], PAPERS[1], "arXiv:2412.19543", PAPERS[2], "f-0000000a", "f-0000000b"]);
	assert.deepEqual(vs.find((v) => v.by === "focus-fx-0123abcd")?.focus, { key: "fx-0123abcd", outcome: "holds" });
	assert.match(readFileSync(t.orchestratorState, "utf8"), new RegExp(`## Ledger pruned \\d{4}-\\d\\d-\\d\\d\\n.*Kept \\(3\\): ${fid(1)}, ${fid(2)}, ${fid(3)}`));
	assert.equal(readFileSync(join(t.dir, "ledger.pre-v2.jsonl"), "utf8"), before, "a second run keeps the original backup");
	if (existsSync(ADD_PY)) assert.match(readFileSync(entry, "utf8"), new RegExp(`Title of ${fid(1)}`));
});

test("migrate refuses to apply while a reformat failed or the topic is running", async () => {
	const { root, t } = legacyTopic();
	const before = readFileSync(t.ledger, "utf8");
	await assert.rejects(() => migrate({ root, slug: t.slug, apply: true, reformat: fake([], new Set([fid(2)])) }), /1 reformat failure/);
	assert.equal(readFileSync(t.ledger, "utf8"), before);
	assert.deepEqual(readFindings(join(t.dir, "ledger.v2-preview.jsonl")).map((f) => f.id), [fid(1), fid(3)], "successes are kept for the next run");
	assert.ok(!readVerifications(join(t.dir, "verifications.v2-preview.jsonl")).some((v) => v.findingId === fid(2)), "previews stay consistent");

	// An agent error fails only its finding.
	const throwing: Reformat = async (f) => {
		if (f.id === fid(2)) throw new Error("provider down");
		return fake([])(f);
	};
	const r = await migrate({ root, slug: t.slug, apply: false, reformat: throwing });
	assert.deepEqual(r.failed, [fid(2)]);

	// Extra-usage billing aborts the whole run and still releases the lock.
	rmSync(join(t.dir, "ledger.v2-preview.jsonl"));
	await assert.rejects(() => migrate({ root, slug: t.slug, apply: false, reformat: async () => { throw new OverageError("overage"); } }), OverageError);
	assert.ok(!existsSync(join(t.dir, ".lock")));

	writeFileSync(join(t.dir, ".lock"), String(process.pid));
	await assert.rejects(() => migrate({ root, slug: t.slug, apply: false, reformat: fake([]) }), /is running/);
});
