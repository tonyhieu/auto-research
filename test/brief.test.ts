import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duplicateOf, validateBrief, withCanonicalConstraints } from "../src/brief.ts";
import { DEFAULT_CONFIG, type SelectDecision } from "../src/portfolio.ts";
import { parseSelect, validateSelect } from "../src/analyst.ts";
import { type Decider, runPortfolio, type Runner } from "../src/driver.ts";
import { type Selector } from "../src/analyst.ts";
import { ensureTopic, slugify } from "../src/topic.ts";

const existing = [{ slug: "diversity-weighted-synthetic-data", title: "Diversity-weighted synthetic data" }];
const body =
	"## Question\nDoes error-cluster weighting beat class rebalancing on rare-class F1?\n\n## Prior work\nJTT upweights a proxy model's mistakes; CReST rebalances self-training; class-balanced loss reweights by inverse frequency. We ask how these compose in a recursive accumulate loop and where novelty remains.\n\n## Method\nSimulate a logistic student and generator in the sandbox on 20NG and Covertype; compare arms over several generations.";

test("withCanonicalConstraints drops a drafted constraints section and appends the canonical one", () => {
	const drafted = `${body}\n\n## Constraints\n- we have a GPU cluster and ImageNet`; // a hallucinated constraint
	const out = withCanonicalConstraints(drafted);
	assert.ok(!out.includes("GPU cluster and ImageNet"), "drafted constraints removed");
	assert.ok(out.includes("20 Newsgroups") && out.includes("Covertype"), "canonical constraints appended");
});

test("duplicateOf catches slug collisions and near-duplicate titles", () => {
	assert.equal(duplicateOf("Diversity-weighted synthetic data", existing), "diversity-weighted-synthetic-data");
	assert.equal(duplicateOf("Diversity weighted synthetic data!!", existing), "diversity-weighted-synthetic-data", "slug collision");
	assert.equal(duplicateOf("Spectral clustering of gradients", existing), undefined);
});

test("validateBrief rejects thin, duplicate, or oversized briefs and injects constraints", () => {
	assert.equal(validateBrief("", body, existing).ok, false, "needs a title");
	assert.equal(validateBrief("Diversity-weighted synthetic data", body, existing).ok, false, "duplicate");
	assert.equal(validateBrief("New angle", "too short", existing).ok, false, "thin brief");
	const v = validateBrief("Noise-robust rebalancing", body, existing);
	assert.ok(v.ok && v.slug === "noise-robust-rebalancing" && v.brief.includes("20 Newsgroups"));
});

test("validateSelect: work must name an existing slug; new-topic must pass the brief check", () => {
	assert.equal((validateSelect(parseSelect('{"decision":{"kind":"work","slug":"diversity-weighted-synthetic-data"}}'), { existing, cfg: DEFAULT_CONFIG }) as any).decision.kind, "work");
	assert.equal(validateSelect(parseSelect('{"decision":{"kind":"work","slug":"nope"}}'), { existing, cfg: DEFAULT_CONFIG }).ok, false);
	const nt = validateSelect({ decision: { kind: "new-topic", title: "Error-cluster weighting", area: "weighting", brief: body } }, { existing, cfg: DEFAULT_CONFIG });
	assert.ok(nt.ok && (nt.decision as Extract<SelectDecision, { kind: "new-topic" }>).brief.includes("Covertype"));
});

test("runPortfolio: a new-topic seeds a brief and runs breadth, then work retires, then stop", async () => {
	const root = mkdtempSync(join(tmpdir(), "ar-portfolio-"));
	const topicsRoot = mkdtempSync(join(tmpdir(), "ar-topics-"));
	const title = "Error Cluster Weighting";
	const decisions: { decision: SelectDecision; rationale: string }[] = [
		{ decision: { kind: "new-topic", title, area: "weighting", brief: body }, rationale: "fresh area" },
		{ decision: { kind: "work", slug: slugify(title) }, rationale: "advance it" },
		{ decision: { kind: "stop", reason: "done" }, rationale: "stop" },
	];
	let i = 0;
	const select: Selector = async () => decisions[i++];
	const decide: Decider = async () => ({ action: { kind: "retire", reason: "mined out" }, rationale: "retire" });
	const runner: Runner = {
		research: async (args) => {
			const t = ensureTopic(args[1], topicsRoot);
			writeFileSync(t.runs, JSON.stringify({ event: "end", runId: "r", ts: new Date().toISOString(), exitCode: 0, reason: "complete", findings: 0 }) + "\n");
			return 0;
		},
		preprint: async () => 0,
	};
	await runPortfolio({ root, runner, topicsRoot, cfg: { ...DEFAULT_CONFIG, area: "weighting", maxCycles: 6 }, select, decide, sleep: async () => {}, log: () => {} });

	const entries = readFileSync(join(root, "decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(entries.map((e) => e.select.kind), ["new-topic", "work", "stop"]);
	assert.equal(entries[0].action.kind, "breadth", "new-topic runs a first breadth window");
	const p = JSON.parse(readFileSync(join(root, "portfolio.json"), "utf8"));
	const rec = p.topics.find((t: { slug: string }) => t.slug === slugify(title));
	assert.equal(rec.status, "retired");
	assert.equal(rec.area, "weighting");
});
