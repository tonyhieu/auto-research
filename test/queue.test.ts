import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveBrief, nextQueuedBrief } from "../src/queue.ts";
import { DEFAULT_CONFIG, type SelectDecision } from "../src/portfolio.ts";
import { type Decider, runPortfolio, type Runner } from "../src/driver.ts";
import { type Selector } from "../src/analyst.ts";
import { ensureTopic, slugify } from "../src/topic.ts";

const brief = (title: string) =>
	`# ${title}\n\n## Question\nDoes error-cluster weighting beat class rebalancing on rare-class F1?\n\n## Prior work\nJTT, CReST, and class-balanced loss all touch this; we ask how they compose in a recursive accumulate loop and where novelty remains.\n\n## Method\nSimulate a logistic student and generator in the sandbox across several generations.`;

test("nextQueuedBrief takes the oldest .md, reads its H1 title, and ignores subfolders", () => {
	const dir = mkdtempSync(join(tmpdir(), "ar-queue-"));
	mkdirSync(join(dir, "done"), { recursive: true });
	writeFileSync(join(dir, "done", "old.md"), "# Already done\n");
	writeFileSync(join(dir, "a-topic.md"), brief("Spectral Gradient Clustering"));
	const q = nextQueuedBrief(dir);
	assert.equal(q?.title, "Spectral Gradient Clustering");
	assert.ok(q?.brief.includes("## Method"));
});

test("archiveBrief moves a brief to done/ or rejected/ with a reason", () => {
	const dir = mkdtempSync(join(tmpdir(), "ar-queue-"));
	const file = join(dir, "x.md");
	writeFileSync(file, brief("X"));
	archiveBrief(file, "rejected", "too close to an existing topic");
	assert.ok(!existsSync(file));
	assert.ok(existsSync(join(dir, "rejected", "x.md")));
	assert.equal(readFileSync(join(dir, "rejected", "x.md.reason.txt"), "utf8").trim(), "too close to an existing topic");
});

test("runPortfolio processes a queued human brief before the selector, then archives it", async () => {
	const root = mkdtempSync(join(tmpdir(), "ar-portfolio-"));
	const topicsRoot = mkdtempSync(join(tmpdir(), "ar-topics-"));
	const queueDir = mkdtempSync(join(tmpdir(), "ar-queue-"));
	writeFileSync(join(queueDir, "lead.md"), brief("Human Lead Topic"));
	// The selector would only run after the queue drains; make it stop so the test ends.
	const select: Selector = async () => ({ decision: { kind: "stop", reason: "done" } as SelectDecision, rationale: "stop" });
	const decide: Decider = async () => ({ action: { kind: "breadth", windows: 1 }, rationale: "n/a" });
	const runner: Runner = {
		research: async (args) => {
			const t = ensureTopic(args[1], topicsRoot);
			writeFileSync(t.runs, JSON.stringify({ event: "end", runId: "r", ts: new Date().toISOString(), exitCode: 0, reason: "complete", findings: 0 }) + "\n");
			return 0;
		},
		preprint: async () => 0,
	};
	await runPortfolio({ root, runner, topicsRoot, queueDir, cfg: { ...DEFAULT_CONFIG, maxCycles: 4 }, select, decide, sleep: async () => {}, log: () => {} });

	const entries = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(entries.map((e) => e.select.kind), ["new-topic", "stop"], "human brief handled before the selector decision");
	assert.match(entries[0].rationale, /human brief from queue/);
	assert.ok(existsSync(join(queueDir, "done", "lead.md")), "queued brief archived");
	const p = JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8"));
	assert.ok(p.topics.some((t: { slug: string }) => t.slug === slugify("Human Lead Topic")));
});
