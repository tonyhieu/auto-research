import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFinding, createTask, listTasks, queryFindings, readFindings, type Finding } from "../src/ledger.ts";
import { orchestratorPrompt } from "../src/prompts.ts";
import { ensureTopic } from "../src/topic.ts";
import { ledgerTools, STATE_CAP, stateTool, taskTools } from "../src/tools.ts";

const f = (id: string, ts: string, claim: string, extra: Partial<Finding> = {}): Finding => ({
	id,
	ts,
	author: "a",
	claim,
	evidence: "",
	sources: ["p"],
	status: "unverified",
	...extra,
});

const ALL = [
	f("f1", "2026-01-01T00:00:00Z", "Consistency models degrade with more sampling steps"),
	f("f2", "2026-01-02T00:00:00Z", "Flow maps avoid multi-step degradation", { evidence: "consistency models comparison" }),
	f("f3", "2026-01-03T00:00:00Z", "Model collapse is driven by entropy loss", { status: "refuted", taskId: "t-1" }),
];

test("queryFindings ranks claim hits above evidence hits, then by recency", () => {
	const { items, matched } = queryFindings(ALL, { query: "consistency models" });
	assert.deepEqual(items.map((x) => x.id), ["f1", "f2"]);
	assert.equal(matched, 2);
});

test("queryFindings filters by status/taskId/since and caps with limit", () => {
	assert.deepEqual(queryFindings(ALL, { status: "refuted" }).items.map((x) => x.id), ["f3"]);
	assert.deepEqual(queryFindings(ALL, { taskId: "t-1" }).items.map((x) => x.id), ["f3"]);
	assert.deepEqual(queryFindings(ALL, { since: "2026-01-01T12:00:00Z" }).items.map((x) => x.id), ["f3", "f2"]);
	const page = queryFindings(ALL, { limit: 1 });
	assert.deepEqual([page.items.map((x) => x.id), page.matched], [["f3"], 3]);
});

const call = (tool: { execute: Function }, params: object) => tool.execute("id", params, undefined, undefined, {});
const out = (r: { content: { text: string }[] }) => r.content[0].text;

test("ledger_list truncates long claims and reports counts; ledger_get returns full evidence", async () => {
	const t = ensureTopic("lt", mkdtempSync(join(tmpdir(), "ar-")));
	const long = "x".repeat(500);
	const rec = appendFinding(t.ledger, { author: "a", claim: long, evidence: "full evidence here", sources: ["p1"], status: "unverified" });
	const lt = ledgerTools(t, "a");
	const listed = out(await call(lt.list, {}));
	assert.match(listed, /^Showing 1 of 1 matching \(1 total\)\./);
	assert.ok(listed.length < 400, "claim truncated");
	const got = out(await call(lt.get, { ids: [rec.id, "f-nope"] }));
	assert.match(got, /Evidence: full evidence here/);
	assert.match(got, /Not found: f-nope/);
	assert.equal(readFindings(t.ledger).length, 1);
});

test("state_write enforces the size cap", async () => {
	const t = ensureTopic("st", mkdtempSync(join(tmpdir(), "ar-")));
	const tool = stateTool(t);
	await assert.rejects(() => call(tool, { content: "y".repeat(STATE_CAP + 1) }), /limit is 6000/);
	assert.match(readFileSync(t.orchestratorState, "utf8"), /no epochs run yet/, "oversized write left state untouched");
	await call(tool, { content: "## Map\nok" });
	assert.equal(readFileSync(t.orchestratorState, "utf8"), "## Map\nok");
});

test("task_list shows active tasks and only recent done ones", async () => {
	const t = ensureTopic("tl", mkdtempSync(join(tmpdir(), "ar-")));
	const tt = taskTools(t);
	for (let i = 0; i < 35; i++) createTask(t.tasks, `done ${i}`, "d");
	const { updateTask } = await import("../src/ledger.ts");
	for (const task of listTasks(t.tasks)) updateTask(t.tasks, { ...task, status: "done" });
	createTask(t.tasks, "open one", "d");
	const listed = out(await call(tt.list, {}));
	assert.match(listed, /^1 open\/claimed, 35 done \(showing last 30\)\./);
	assert.match(listed, /open one/);
	assert.equal(listed.split("\n").length, 1 + 1 + 30);
});

test("orchestrator prompt carries saved state and since-last-epoch stats", () => {
	const p = orchestratorPrompt({
		epoch: 4,
		state: "## Map\nfoo",
		since: "2026-01-01T12:00:00Z",
		findings: ALL,
		tasks: [],
		objections: [],
	});
	assert.match(p, /epoch 4/);
	assert.match(p, /3 total \(2 unverified, 1 refuted; novelty: none\); 2 new since last epoch/);
	assert.match(p, /ledger_list since="2026-01-01T12:00:00Z"/);
	assert.match(p, /## Map\nfoo/);
});

test("brief is injected into every role's system prompt, and absent when not given", async () => {
	const { orchestratorSystem, subagentSystem, verifierSystem, summarySystem } = await import("../src/prompts.ts");
	const { writeFileSync } = await import("node:fs");
	const t = ensureTopic("Brief Topic", mkdtempSync(join(tmpdir(), "ar-")));
	const roles = [orchestratorSystem, subagentSystem, verifierSystem, summarySystem];
	for (const r of roles) assert.doesNotMatch(r(t), /<brief>/);
	writeFileSync(t.brief, "Focus on safety data generation.\n");
	for (const r of roles) assert.match(r(t), /<brief>\nFocus on safety data generation\.\n<\/brief>/);
});
