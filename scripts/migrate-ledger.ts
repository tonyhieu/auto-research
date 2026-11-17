// One-time v2 migration: prune findings that are not verified or are known results, reformat the survivors with an agent, normalize verifications.
// Usage: tsx scripts/migrate-ledger.ts --topic <slug> [--apply] [--root topics] [--concurrency 4]. Without --apply only preview files are written.
import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { OverageError, runAgent } from "../src/agent.ts";
import { loadFindings, readFindings, readVerifications, type Finding, type Verification } from "../src/ledger.ts";
import { ADD_PY, insightSlug, promoteToMemory } from "../src/memory.ts";
import { assertFinding, assertVerification, findingFields, findingInputParams, type FindingInput } from "../src/schema.ts";
import { acquireLock, ensureTopic, REPO_ROOT, slugify } from "../src/topic.ts";

/** Reformats one finding; undefined when the agent gave up. Injected so tests can fake the agent. */
export type Reformat = (f: Finding) => Promise<FindingInput | undefined>;

export interface Selection {
	keep: Finding[];
	deleted: { unverified: string[]; refuted: string[]; known: string[] };
}

/** Keep verified findings whose latest novelty verdict is not fail; `keep` holds the records as written, in ledger order. */
export function selectFindings(t: { ledger: string; verifications: string }): Selection {
	const effective = new Map(loadFindings(t).map((f) => [f.id, f]));
	const out: Selection = { keep: [], deleted: { unverified: [], refuted: [], known: [] } };
	for (const f of readFindings(t.ledger)) {
		const e = effective.get(f.id)!;
		if (e.status !== "verified") out.deleted[e.status].push(f.id);
		else if (e.novelty === "known") out.deleted.known.push(f.id);
		else out.keep.push(f);
	}
	return out;
}

const SOURCE = new RegExp((findingFields.sources.items as { pattern: string }).pattern);
const ARXIV = /^\d{4}\.\d{4,5}(v\d+)?$/;
const PAPER_ID = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/;

const decode = (s: string): string[] => {
	try {
		const x = JSON.parse(s);
		return Array.isArray(x) ? x.map(String) : [s];
	} catch {
		return [s];
	}
};

/**
 * Turn legacy source entries into schema ids: JSON-encoded arrays and comma lists are split, bare arXiv ids
 * get the arXiv: prefix, and a label around a paperId (e.g. "Name-<paperId>") is cut to the id. The rest is dropped.
 */
export function normalizeSources(sources: string[]): { sources: string[]; dropped: string[] } {
	const out: string[] = [];
	const dropped: string[] = [];
	for (const raw of sources) {
		const parts = raw.trim().startsWith("[") ? decode(raw.trim()) : raw.split(",");
		for (const p of parts.map((s) => s.trim()).filter(Boolean)) {
			const id = SOURCE.test(p) ? p : ARXIV.test(p) ? `arXiv:${p}` : p.match(PAPER_ID)?.[0];
			if (id) out.push(id);
			else dropped.push(p);
		}
	}
	return { sources: [...new Set(out)], dropped };
}

const FOCUS_RATIONALE = /^Focus (fx-[0-9a-f]{8}) verdict: (holds|holds_with_limits|fails)\./;

/** Normalized sources, plus the focus outcome recovered from a focus verdict's rationale. */
export function migrateVerification(v: Verification): { v: Verification; dropped: string[] } {
	const { sources, dropped } = normalizeSources(v.sources);
	const m = v.focus ? undefined : v.rationale.match(FOCUS_RATIONALE);
	const focus = m ? { focus: { key: m[1], outcome: m[2] as "holds" | "holds_with_limits" | "fails" } } : {};
	return { v: { ...v, sources, ...focus }, dropped };
}

// f- finding ids and fx- focus keys, t- task ids, paperIds.
const ID = /\b(?:fx?-[0-9a-f]{8}|t-[0-9a-f]{8})\b|(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g;
const ids = (s: string) => new Set(s.match(ID) ?? []);
const numbers = (s: string) => new Set(s.replace(ID, " ").match(/\d+(?:\.\d+)?/g) ?? []);

/** Why a reformat changed the content: ids lost or added, or numbers that the original does not contain. */
export function contentProblems(orig: Finding, p: FindingInput): string[] {
	const before = `${orig.claim}\n${orig.evidence}`;
	const after = [p.title, p.claim, p.evidence, p.experiment?.setup ?? "", p.experiment?.results ?? ""].join("\n");
	const [ib, ia, nb] = [ids(before), ids(after), numbers(before)];
	const out: string[] = [];
	const lost = [...ib].filter((x) => !ia.has(x));
	const added = [...ia].filter((x) => !ib.has(x) && !orig.sources.includes(x));
	const newNumbers = [...numbers(after)].filter((x) => !nb.has(x));
	if (lost.length) out.push(`ids missing from the rewrite: ${lost.join(", ")}`);
	if (added.length) out.push(`ids not in the original: ${added.join(", ")}`);
	if (newNumbers.length) out.push(`numbers not in the original (keep every number exactly as written): ${newNumbers.join(", ")}`);
	return out;
}

/** submit_finding: the agent's only tool. Its parameters are the exported FindingInput schema, so pi rejects invalid output. */
export function submitTool(orig: Finding, onSubmit: (p: FindingInput) => void): ToolDefinition {
	return defineTool({
		name: "submit_finding",
		label: "Submit finding",
		description: "Submit the reformatted finding. Rejected with a reason if the content changed; fix it and call again.",
		parameters: findingInputParams,
		async execute(_id, p) {
			const problems = contentProblems(orig, p);
			if (problems.length) throw new Error(problems.join("; "));
			onSubmit(p);
			return { content: [{ type: "text" as const, text: "Recorded. Reply DONE." }], details: undefined };
		},
	});
}

const SYSTEM = `You reformat one research finding into a stricter ledger format. You have one tool, submit_finding. Call it with the reformatted finding, fix any error it returns, then reply DONE.

Rules:
- title: a short headline for lists (8-100 chars, one line).
- claim: one line, at most 1000 chars, with the same meaning as the original. If it is too long, move supporting detail into the evidence.
- evidence: Markdown, at most 4000 chars. Use bullets (not numbered lists) and put results in GFM tables.
- experiment: only if the evidence already describes a computation. setup = data, model, parameters, seeds (at most 2500 chars); results = the numbers, preferably a table (at most 2500 chars). Otherwise pass null.
- Keep every number, finding id (f-...), task id (t-...), focus key (fx-...), and paperId exactly as written. Do not add numbers that are not in the original; you may drop detail to fit the limits.
- kind and sources: pass them unchanged.`;

const prompt = (f: Finding) =>
	`Reformat this finding.\n\nkind: ${f.kind ?? "insight"}\nsources: ${JSON.stringify(f.sources)}\n\nclaim:\n${f.claim}\n\nevidence:\n${f.evidence}`;

/** The real reformat: one agent call with no file tools, retried once if the agent ends without a valid submission. */
export function agentReformat(models: ModelRuntime, cwd: string, log: (s: string) => void): Reformat {
	return async (f) => {
		for (let attempt = 1; attempt <= 2; attempt++) {
			let out: FindingInput | undefined;
			const r = await runAgent({ name: `migrate-${f.id}`, cwd, systemPrompt: SYSTEM, prompt: prompt(f), builtinTools: [], tools: [submitTool(f, (p) => (out = p))], models, log });
			if (out) return out;
			log(`[migrate-${f.id}] attempt ${attempt} ended without a valid submission${r.interrupted ? ` (${r.interrupted})` : ""}`);
		}
		return undefined;
	};
}

/** The new ledger line: content from the agent, everything else copied from the original. */
function rebuild(orig: Finding, p: Pick<FindingInput, "title" | "claim" | "evidence" | "experiment">): Finding {
	return {
		id: orig.id,
		ts: orig.ts,
		author: orig.author,
		...(orig.taskId ? { taskId: orig.taskId } : {}),
		kind: orig.kind ?? "insight",
		title: p.title,
		claim: p.claim,
		evidence: p.evidence,
		...(p.experiment ? { experiment: p.experiment } : {}),
		sources: orig.sources,
		status: orig.status,
		...(orig.role ? { role: orig.role } : {}),
	};
}

const errorOf = (assert: (x: unknown) => void, x: unknown) => {
	try {
		assert(x);
		return undefined;
	} catch (e) {
		return (e as Error).message;
	}
};

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
	let i = 0;
	await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
		while (i < items.length) await fn(items[i++]);
	}));
}

const writeAtomic = (path: string, lines: object[]) => {
	writeFileSync(`${path}.tmp`, lines.map((x) => JSON.stringify(x) + "\n").join(""));
	renameSync(`${path}.tmp`, path);
};

/** The topic's real title: topic.json, else the orchestrator state header, else the slug. */
function topicTitle(dir: string, slug: string): string {
	const meta = join(dir, "topic.json");
	const title = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")).title : undefined;
	if (typeof title === "string") return title;
	const state = join(dir, "state", "orchestrator.md");
	const m = existsSync(state) ? readFileSync(state, "utf8").match(/^# Orchestrator state: (.+)$/m) : null;
	return m?.[1].trim() ?? slug;
}

export interface MigrateOptions {
	root: string;
	slug: string;
	apply: boolean;
	reformat: Reformat;
	concurrency?: number;
	log?: (s: string) => void;
}

export interface MigrateResult {
	selection: Selection;
	failed: string[];
	invalid: string[];
	summary: string;
	applied: boolean;
}

export async function migrate(o: MigrateOptions): Promise<MigrateResult> {
	const log = o.log ?? (() => {});
	const dir = join(o.root, o.slug);
	const t = { ledger: join(dir, "ledger.jsonl"), verifications: join(dir, "verifications.jsonl") };
	if (!existsSync(t.ledger)) throw new Error(`no ledger at ${t.ledger}`);
	const lock = join(dir, ".lock");
	if (!acquireLock(lock)) throw new Error(`topic "${o.slug}" is running (pid ${readFileSync(lock, "utf8")}); stop it first`);
	try {
		// topics/ is gitignored, so this is the only way back; an earlier backup is never overwritten.
		for (const [src, bak] of [[t.ledger, "ledger.pre-v2.jsonl"], [t.verifications, "verifications.pre-v2.jsonl"]]) {
			if (!existsSync(join(dir, bak))) copyFileSync(src, join(dir, bak));
		}

		const selection = selectFindings(t);

		// The preview doubles as a cache, so --apply writes what was reviewed instead of a fresh rewrite.
		const preview = join(dir, "ledger.v2-preview.jsonl");
		const cached = new Map(existsSync(preview) ? readFindings(preview).map((f) => [f.id, f]) : []);
		const rewritten = new Map<string, Finding>();
		const failed: string[] = [];
		const todo = selection.keep.filter((f) => {
			const c = cached.get(f.id);
			if (c) rewritten.set(f.id, rebuild(f, c));
			return !c;
		});
		log(`${selection.keep.length} kept, ${todo.length} to reformat (${selection.keep.length - todo.length} from the preview)`);
		await pool(todo, o.concurrency ?? 4, async (f) => {
			let p: FindingInput | undefined;
			let err: string | undefined;
			try {
				p = await o.reformat(f);
			} catch (e) {
				// Extra-usage billing stops everything; any other agent error fails just this finding.
				if (e instanceof OverageError) throw e;
				err = String(e);
			}
			const nf = p && rebuild(f, p);
			err ??= nf ? errorOf(assertFinding, nf) : "no submission";
			if (err || !nf) {
				failed.push(f.id);
				log(`${f.id}: reformat failed: ${err}`);
				return;
			}
			rewritten.set(f.id, nf);
			// Crash cache only: the preview is rewritten in ledger order below.
			appendFileSync(preview, JSON.stringify(nf) + "\n");
			log(`${f.id}: reformatted (${rewritten.size}/${selection.keep.length})`);
		});
		const findings = selection.keep.flatMap((f) => rewritten.get(f.id) ?? []);
		const written = new Set(findings.map((f) => f.id));

		const vsAll = readVerifications(t.verifications);
		const dropped: string[] = [];
		const verifications = vsAll
			.filter((v) => written.has(v.findingId))
			.map((v0) => {
				const { v, dropped: d } = migrateVerification(v0);
				dropped.push(...d.map((s) => `${v.id}: ${s}`));
				return v;
			});

		const invalid = [
			...findings.map((f) => [f.id, errorOf(assertFinding, f)]),
			...verifications.map((v) => [v.id, errorOf(assertVerification, v)]),
		].flatMap(([id, e]) => (e ? [`${id}: ${e}`] : []));
		writeAtomic(preview, findings);
		writeAtomic(join(dir, "verifications.v2-preview.jsonl"), verifications);

		const claimStats = (fs: Finding[]) => {
			const n = fs.map((f) => f.claim.length);
			return `max ${Math.max(0, ...n)}, mean ${Math.round(n.reduce((a, b) => a + b, 0) / (n.length || 1))}, over 1000: ${n.filter((x) => x > 1000).length}`;
		};
		const original = new Map(vsAll.map((v) => [v.id, v]));
		const novelty = (id: string) => vsAll.filter((v) => v.findingId === id && v.check === "novelty").sort((a, b) => a.ts.localeCompare(b.ts)).at(-1)?.verdict ?? "unchecked";
		const tally = (keys: string[]) => [...new Set(keys)].map((k) => `${k} ${keys.filter((x) => x === k).length}`).join(", ");
		const byNovelty = tally(selection.keep.map((f) => novelty(f.id)));
		const byKind = tally(selection.keep.map((f) => f.kind ?? "insight"));
		const d = selection.deleted;
		const summary = `# Ledger migration preview: ${o.slug}

- Kept ${selection.keep.length} findings (novelty: ${byNovelty}; kind: ${byKind}).
- Deleted ${d.unverified.length + d.refuted.length + d.known.length}: unverified ${d.unverified.length}, refuted ${d.refuted.length}, known (novelty fail) ${d.known.length}.
- Verifications kept ${verifications.length} of ${vsAll.length}; sources changed on ${verifications.filter((v) => JSON.stringify(v.sources) !== JSON.stringify(original.get(v.id)!.sources)).length}; focus outcomes set on ${verifications.filter((v) => v.focus && !original.get(v.id)!.focus).length}.
- Claim length before: ${claimStats(selection.keep)}. After: ${claimStats(findings)}.
- Reformat failed (${failed.length}): ${failed.join(", ") || "none"}.
- Invalid lines (${invalid.length}):${invalid.map((s) => `\n  - ${s}`).join("") || " none"}
- Dropped source entries (${dropped.length}):${dropped.map((s) => `\n  - ${s}`).join("") || " none"}

## Kept ids
${selection.keep.map((f) => f.id).join(", ")}
`;
		writeFileSync(join(dir, "migration.v2-preview.md"), summary);

		if (!o.apply) return { selection, failed, invalid, summary, applied: false };
		if (failed.length || invalid.length) throw new Error(`not applied: ${failed.length} reformat failure(s), ${invalid.length} invalid line(s); see migration.v2-preview.md`);
		writeAtomic(t.ledger, findings);
		writeAtomic(t.verifications, verifications);
		log(`applied: ${findings.length} findings, ${verifications.length} verifications`);

		// Without this the next breadth orchestrator would chase findings that no longer exist.
		const date = new Date().toISOString().slice(0, 10);
		appendFileSync(
			join(dir, "state", "orchestrator.md"),
			`\n## Ledger pruned ${date}\nThe ledger now holds only verified findings that are not known results; any id not listed here was deleted. Kept (${findings.length}): ${findings.map((f) => f.id).join(", ")}\n`,
		);

		// Rewrite memory entries of kept verified+novel findings so they get the new titles and Markdown.
		const title = topicTitle(dir, o.slug);
		if (slugify(title) !== o.slug) log(`memory skipped: title "${title}" does not slugify to ${o.slug}`);
		else if (!existsSync(ADD_PY)) log(`memory skipped: ${ADD_PY} not found`);
		else {
			const topic = ensureTopic(title, o.root);
			for (const f of loadFindings(topic).filter((x) => x.status === "verified" && x.novelty === "novel")) {
				rmSync(join(topic.memory, `${insightSlug(topic, f)}.md`), { force: true });
			}
			const r = promoteToMemory(topic);
			log(`memory: ${r.written.length} entries written${r.errors.length ? `; errors: ${r.errors.join("; ")}` : ""}`);
		}
		return { selection, failed, invalid, summary, applied: true };
	} finally {
		if (existsSync(lock)) unlinkSync(lock);
	}
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			topic: { type: "string" },
			apply: { type: "boolean", default: false },
			root: { type: "string", default: join(REPO_ROOT, "topics") },
			concurrency: { type: "string", default: "4" },
		},
	});
	if (!values.topic) throw new Error("usage: tsx scripts/migrate-ledger.ts --topic <slug> [--apply] [--root topics] [--concurrency 4]");
	const dir = join(values.root, values.topic);
	const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
	// SIGINT would skip the finally block, so release the lock here; finished reformats stay in the preview.
	process.on("SIGINT", () => {
		const lock = join(dir, ".lock");
		if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
		process.exit(130);
	});
	const models = await ModelRuntime.create();
	const r = await migrate({ root: values.root, slug: values.topic, apply: values.apply, reformat: agentReformat(models, dir, log), concurrency: Number(values.concurrency), log });
	console.log(r.summary.split("\n## Kept ids")[0]);
	console.log(r.applied ? "applied" : `preview written to ${dir}; rerun with --apply to replace the ledger`);
	process.exit(r.failed.length || r.invalid.length ? 1 : 0);
}
