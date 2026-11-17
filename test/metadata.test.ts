import { test } from "node:test";
import assert from "node:assert/strict";
import { PAPER, VALID } from "./records.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFinding, type Finding } from "../src/ledger.ts";
import { insightEntry } from "../src/memory.ts";
import { recordRunEnd, recordRunStart } from "../src/runs.ts";
import { getPaper, searchPapers, setPaperCache } from "../src/s2.ts";
import { ensureTopic, REPO_ROOT, slugify } from "../src/topic.ts";

const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Shared with ui/tests (the server's slugify port), so both compute the same topic dir.
test("slugify matches the shared title -> slug fixture", () => {
	const pairs: [string, string][] = JSON.parse(readFileSync(join(REPO_ROOT, "test/fixtures/slugify.json"), "utf8"));
	for (const [title, slug] of pairs) assert.equal(slugify(title), slug, JSON.stringify(title));
});

test("ensureTopic writes topic.json once with the real title", () => {
	const root = mkdtempSync(join(tmpdir(), "ar-"));
	const t = ensureTopic("Diffusion: Models!", root);
	const meta = JSON.parse(readFileSync(join(t.dir, "topic.json"), "utf8"));
	assert.equal(meta.slug, "diffusion-models");
	assert.equal(meta.title, "Diffusion: Models!");
	assert.ok(!Number.isNaN(Date.parse(meta.created)));
	ensureTopic("diffusion models", root);
	assert.equal(JSON.parse(readFileSync(join(t.dir, "topic.json"), "utf8")).title, "Diffusion: Models!", "not overwritten");
	assert.equal(t.runs, join(t.dir, "state", "runs.jsonl"));
	assert.equal(t.papers, join(t.dir, "papers.jsonl"));
});

test("run events: start and end share a run id; reason comes from the exit code", () => {
	const t = ensureTopic("runs", mkdtempSync(join(tmpdir(), "ar-")));
	appendFinding(t.ledger, { ...VALID, author: "a", kind: "insight", claim: "c is the claim under test", status: "unverified" });
	const start = { pid: 1, mode: "focus" as const, focusKey: "fx-12345678", target: "f-12345678", windows: 1, concurrency: 3, log: "logs/run.log", origin: "ui" as const };
	const ids = [0, 130, 1].map((code) => {
		const id = recordRunStart(t, start);
		recordRunEnd(t, id, code);
		return id;
	});
	const ev = lines(t.runs);
	assert.match(ids[0], /^r-[0-9a-f]{8}$/);
	assert.deepEqual(ev.map((e) => e.event), ["start", "end", "start", "end", "start", "end"]);
	assert.deepEqual(ev.filter((e) => e.event === "end").map((e) => [e.runId, e.reason, e.findings]), [
		[ids[0], "complete", 1],
		[ids[1], "signal", 1],
		[ids[2], "error", 1],
	]);
	const { ts: _ts, runId: _id, ...first } = ev[0];
	assert.deepEqual(first, { event: "start", ...start });
});

// No auth in a temp HOME: the run starts, then fails fast in the controller without calling any model.
test("cli writes start and end events to state/runs.jsonl", () => {
	const title = `zz cli runs ${process.pid}`;
	const dir = join(REPO_ROOT, "topics", title.replace(/ /g, "-"));
	try {
		const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "-t", title, "-n", "1", "-c", "1"], {
			cwd: REPO_ROOT,
			env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "ar-home-")), RESEARCH_ORIGIN: "ui" },
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.notEqual(r.status, 0);
		const [start, end] = lines(join(dir, "state", "runs.jsonl"));
		assert.equal(start.event, "start");
		assert.equal(start.mode, "breadth");
		assert.equal(start.origin, "ui");
		assert.equal(start.pid, r.pid);
		assert.match(start.log, /^logs\/run-.*\.log$/);
		assert.deepEqual([end.event, end.runId, end.exitCode, end.reason, end.findings], ["end", start.runId, r.status, "error", 0]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("s2 paper cache: one compact line per paper per process", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "ar-")), "papers.jsonl");
	const paper = (id: string) => ({ paperId: id, title: `T ${id}`, year: 2024, venue: "V", abstract: "long", authors: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }] });
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const body = String(url).includes("/paper/search") ? { data: [paper("p1"), paper("p2")] } : paper("p1");
		return new Response(JSON.stringify(body), { status: 200 });
	};
	try {
		setPaperCache(path);
		await searchPapers("q");
		await getPaper("p1");
	} finally {
		globalThis.fetch = realFetch;
		setPaperCache(join(tmpdir(), "unused"));
	}
	assert.deepEqual(lines(path), [
		{ paperId: "p1", title: "T p1", year: 2024, venue: "V", authors: ["A", "B", "C"] },
		{ paperId: "p2", title: "T p2", year: 2024, venue: "V", authors: ["A", "B", "C"] },
	]);
});

test("memory insight entry uses the title and includes the experiment", () => {
	const t = ensureTopic("Mem Topic", mkdtempSync(join(tmpdir(), "ar-")));
	const f: Finding = { id: "f-12345678", ts: "2026-01-01T00:00:00Z", author: "a", kind: "insight", title: "Short headline", claim: "c".repeat(200), evidence: "e", sources: ["p"], status: "verified" };
	const e = insightEntry(t, { ...f, experiment: { setup: "SETUP TEXT", results: "| a | b |" } }, []);
	assert.equal(e.title, "Insight (Mem Topic): Short headline");
	assert.match(e.content, /## Experiment\n### Setup\nSETUP TEXT\n\n### Results\n\| a \| b \|/);
	// A line written before the v2 schema has no title.
	const legacy = insightEntry(t, { ...f, title: undefined } as unknown as Finding, []);
	assert.match(legacy.title, /^Insight \(Mem Topic\): c{89}\u2026$/);
	assert.doesNotMatch(legacy.content, /## Experiment/);
});
