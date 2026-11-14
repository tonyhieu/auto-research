import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { SCOPE_TAGS, claimTreeIds, scopeProblems, verdictRecorded, type Focus } from "./focus.ts";
import {
	appendFinding,
	appendVerification,
	createTask,
	listTasks,
	loadFindings,
	queryFindings,
	readFindings,
	readVerifications,
	requeueVerification,
	verificationPending,
	type Finding,
	type VerificationCheck,
} from "./ledger.ts";
import { runPython } from "./sandbox.ts";
import { formatPaper, getPaper, searchPapers } from "./s2.ts";
import type { TopicPaths } from "./topic.ts";

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const MAX_LIST = 50;
const CLAIM_CHARS = 240;
const DONE_SHOWN = 30;
/** A novelty pass must name at least this many papers checked. */
export const NOVELTY_MIN_PAPERS = 5;

/** "[verified, novel, insight]" style tag shown in ledger views. */
const tag = (f: Finding) => `[${[f.status, f.novelty, f.kind].filter(Boolean).join(", ")}]`;

/** paper_search; `onSearch` lets a caller count calls (verifiers must actually search before a novelty verdict). */
export function searchTool(onSearch?: () => void) {
	return defineTool({
		...s2Search,
		async execute(id, p, signal, onUpdate, ctx) {
			onSearch?.();
			return s2Search.execute(id, p, signal, onUpdate, ctx);
		},
	});
}

export const s2Search = defineTool({
	name: "paper_search",
	label: "Paper search",
	description:
		"Search Semantic Scholar for papers. Returns paperId, title, year, venue, authors, citation count, and a truncated abstract. Use paperIds as sources in the ledger.",
	parameters: Type.Object({
		query: Type.String({ description: "Keyword query, e.g. 'flow matching optimal transport'" }),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 10 })),
		year: Type.Optional(Type.String({ description: "Year or range, e.g. '2023-' or '2020-2024'" })),
	}),
	async execute(_id, p) {
		const papers = await searchPapers(p.query, p.limit ?? 10, p.year);
		return text(papers.length ? papers.map((x) => formatPaper(x)).join("\n\n") : "No results.");
	},
});

export const s2Paper = defineTool({
	name: "paper_details",
	label: "Paper details",
	description: "Fetch one paper by Semantic Scholar paperId or prefixed id (e.g. 'arXiv:2210.02747', 'DOI:...'), with full abstract.",
	parameters: Type.Object({ id: Type.String() }),
	async execute(_id, p) {
		return text(formatPaper(await getPaper(p.id), 4000));
	},
});

/** Wrap a fetch tool (ledger_get, paper_details) so the ids it is called with are added to `sink`. */
export function trackFetches(tool: ToolDefinition, sink: Set<string>): ToolDefinition {
	return {
		...tool,
		execute: (id, p: { ids?: string[]; id?: string }, ...rest) => {
			for (const x of p.ids ?? [p.id ?? ""]) sink.add(x);
			return tool.execute(id, p as never, ...rest);
		},
	} as ToolDefinition;
}

export function ledgerTools(topic: TopicPaths, author: string, taskId?: string) {
	const add = defineTool({
		name: "ledger_add",
		label: "Add finding",
		description:
			"Record one atomic finding in the shared research ledger. Every claim must cite sources (paperIds) you actually retrieved. Gaps and insights are independently verified later (citations, refutation attempt, novelty search).",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("literature"), Type.Literal("gap"), Type.Literal("insight")], {
				description:
					"literature: what the cited papers show. gap: an absence claim (no paper among those checked does X). insight: your own inference, hypothesis, or prediction.",
			}),
			claim: Type.String({ description: "One atomic, checkable claim" }),
			evidence: Type.String({ description: "Why the sources support the claim; quote or paraphrase specifics" }),
			sources: Type.Array(Type.String(), { minItems: 1 }),
		}),
		async execute(_id, p) {
			const f = appendFinding(topic.ledger, { author, taskId, ...p, status: "unverified" });
			return text(`Recorded ${f.id}.`);
		},
	});
	const list = defineTool({
		name: "ledger_list",
		label: "List findings",
		description:
			"Search findings recorded by all agents. Pass a keyword `query` to rank by relevance (otherwise newest first); filter by status, taskId, or since. Claims are truncated; use ledger_get for full evidence. Check this before researching to avoid duplicate work.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Keywords, e.g. 'consistency model sampling steps'" })),
			status: Type.Optional(Type.Union([Type.Literal("unverified"), Type.Literal("verified"), Type.Literal("refuted")])),
			taskId: Type.Optional(Type.String()),
			since: Type.Optional(Type.String({ description: "ISO timestamp" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST, default: 20 })),
		}),
		async execute(_id, p) {
			const all = loadFindings(topic);
			if (!all.length) return text("Ledger is empty.");
			const { items, matched } = queryFindings(all, { ...p, limit: Math.min(p.limit ?? 20, MAX_LIST) });
			const head = `Showing ${items.length} of ${matched} matching (${all.length} total).`;
			const lines = items.map(
				(f) => `${f.id} ${tag(f)}${f.taskId ? ` (${f.taskId})` : ""} ${clip(f.claim, CLAIM_CHARS)} (sources: ${f.sources.join(", ")})`,
			);
			return text([head, ...lines].join("\n"));
		},
	});
	const get = defineTool({
		name: "ledger_get",
		label: "Get findings",
		description: "Fetch full findings (claim, evidence, sources, author, task) by id.",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
		async execute(_id, p) {
			const want = new Set(p.ids);
			const fs = loadFindings(topic).filter((f) => want.has(f.id));
			const vs = readVerifications(topic.verifications);
			const missing = p.ids.filter((id) => !fs.some((f) => f.id === id));
			const body = fs.map(
				(f) =>
					`${f.id} ${tag(f)} by ${f.author}${f.taskId ? ` for ${f.taskId}` : ""} at ${f.ts}\nClaim: ${f.claim}\nEvidence: ${f.evidence}\nSources: ${f.sources.join(", ")}` +
					vs
						.filter((v) => v.findingId === f.id)
						.map((v) => `\nCheck ${v.check}: ${v.verdict} (${v.by}) ${clip(v.rationale, 400)}`)
						.join(""),
			);
			if (missing.length) body.push(`Not found: ${missing.join(", ")}`);
			return text(body.join("\n\n"));
		},
	});
	return { add, list, get };
}

/** Record verdicts for one finding; bound to that finding so a verifier cannot touch others. */
/** paper_search calls a verifier must make in its session before recording any novelty verdict. */
export const NOVELTY_MIN_SEARCHES = 3;

export const BASE_CHECKS: VerificationCheck[] = ["citation", "adversarial", "novelty"];

export function verifyTool(
	topic: TopicPaths,
	findingId: string,
	by: string,
	searches: () => number,
	checks: VerificationCheck[] = BASE_CHECKS,
	/** python_run calls this session; any reproduce verdict must rest on the verifier's own attempt. */
	runs: () => number = () => 0,
	/** Ids fetched with ledger_get or paper_details this session; when given, a citation verdict needs one of the finding's sources. */
	fetched?: () => ReadonlySet<string>,
	/** Computational finding with a sandbox: an adversarial verdict must rest on the verifier's own python_run. */
	adversarialNeedsRun = false,
): ToolDefinition {
	return defineTool({
		name: "verify_record",
		label: "Record verdict",
		description: `Record one check's verdict for finding ${findingId}. Call once per check (${checks.join(", ")}). Any novelty verdict requires at least ${NOVELTY_MIN_SEARCHES} paper_search calls in this session first. For novelty, pass means no checked paper anticipates the claim; list every paper you checked in sources (at least ${NOVELTY_MIN_PAPERS}) and the queries you ran in the rationale.`,
		parameters: Type.Object({
			check: Type.Union(checks.map((c) => Type.Literal(c))),
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("inconclusive")]),
			rationale: Type.String({ description: "Specific reasons: quotes, counterexamples, computation results, queries run" }),
			sources: Type.Array(Type.String(), { description: "paperIds checked or supporting the verdict" }),
		}),
		async execute(_id, p) {
			if (p.check === "novelty" && searches() < NOVELTY_MIN_SEARCHES) {
				throw new Error(
					`A novelty verdict (including inconclusive) needs at least ${NOVELTY_MIN_SEARCHES} paper_search calls for prior work; you have made ${searches()}. Run paraphrased queries and related-terms searches first.`,
				);
			}
			if (p.check === "novelty" && p.verdict === "pass" && new Set(p.sources).size < NOVELTY_MIN_PAPERS) {
				throw new Error(
					`A novelty pass needs at least ${NOVELTY_MIN_PAPERS} distinct papers checked; you listed ${new Set(p.sources).size}. Search more (paraphrased queries, related terms) or record inconclusive.`,
				);
			}
			if (p.check === "reproduce" && runs() < 1) {
				throw new Error(
					"A reproduce verdict (including inconclusive) needs your own python_run attempt in this session; another finding's rerun does not count. Rerun what the evidence specifies (fewer seeds or a smaller n is fine if you say so); record inconclusive only if your attempt shows the setup cannot be rebuilt.",
				);
			}
			if (p.check === "adversarial" && adversarialNeedsRun && runs() < 1) {
				throw new Error(
					"An adversarial verdict (including inconclusive) on a computational finding needs your own python_run refutation attempt in this session: rerun the weakest number, a counterexample, or a stress case (a reduced setup is fine if you say so).",
				);
			}
			if (p.check === "citation" && fetched) {
				const sources = readFindings(topic.ledger).find((f) => f.id === findingId)?.sources ?? [];
				const got = fetched();
				if (sources.length && !sources.some((s) => got.has(s))) {
					throw new Error(
						`A citation verdict (including inconclusive) needs you to open the cited sources first: ledger_get for finding ids, paper_details for paperIds. None of ${sources.join(", ")} was fetched this session.`,
					);
				}
			}
			const v = appendVerification(topic.verifications, { findingId, by, ...p });
			return text(`Recorded ${v.check}=${v.verdict} for ${findingId} (${v.id}).`);
		},
	});
}

export interface PythonToolOptions {
	/** Per-call timeout cap. */
	maxSec?: number;
	/** Total sandbox wall time for this tool instance (one agent); calls are clamped to what is left. */
	budgetSec?: number;
	/** Called after each run with its wall time; lets a caller count runs (reproduce verdicts need one). */
	onRun?: (sec: number) => void;
	run?: typeof runPython;
}

/** python_run with a per-call cap and a per-agent wall-time budget. Create one instance per agent. */
export function makePythonTool({ maxSec = 300, budgetSec = Infinity, onRun, run = runPython }: PythonToolOptions = {}) {
	let used = 0;
	const budgetNote = Number.isFinite(budgetSec) ? ` Total sandbox time per agent is ${Math.round(budgetSec / 60)} min; each result reports what is left.` : "";
	return defineTool({
		name: "python_run",
		label: "Run Python",
		description: `Run a Python 3.12 script in an offline sandbox (numpy, scipy, sympy, scikit-learn; no network; 2 GB RAM; files only under /work or /tmp, discarded after). Use for quick numeric checks, symbolic derivations, and toy experiments. timeout_sec is capped at ${maxSec}.${budgetNote} Print what you need; output is capped at 8000 chars.`,
		parameters: Type.Object({
			code: Type.String(),
			timeout_sec: Type.Optional(Type.Integer({ minimum: 1, maximum: maxSec, default: 60 })),
		}),
		async execute(_id, p) {
			const left = budgetSec - used;
			if (left < 1) return text("[refused] Sandbox time budget for this agent is used up. Record what you have and finish; note any experiment left unrun.");
			const start = Date.now();
			const r = await run(p.code, Math.max(1, Math.floor(Math.min(p.timeout_sec ?? 60, maxSec, left))));
			const sec = (Date.now() - start) / 1000;
			used += sec;
			onRun?.(sec);
			const status = r.timedOut ? "timed out" : `exit ${r.exitCode}`;
			const remaining = Number.isFinite(budgetSec) ? `; sandbox time left ${Math.max(0, Math.round(budgetSec - used))}s` : "";
			return text(`[${status}${remaining}]\n${r.output || "(no output)"}`);
		},
	});
}


/**
 * Write a focus run's outcome back to the ledger: a verdict on the target (a free-text hypothesis becomes a
 * finding first), plus an optional narrowed claim queued for verification. Once per focus, and only after
 * the focus has finished at least one research task; any outcome but holds must cite settled refuting findings.
 */
export function focusVerdictTool(topic: TopicPaths, focus: Focus): ToolDefinition {
	const by = `focus-${focus.key}`;
	return defineTool({
		name: "focus_verdict",
		label: "Record focus verdict",
		description:
			"Record the final verdict on the hypothesis in the ledger, in the same epoch you write ## Verdict. holds: the claim stands as written (caveats already stated in the claim do not make it holds_with_limits). holds_with_limits: part of it is refuted; give the surviving narrowedClaim. fails: the main effect does not hold (narrowedClaim optional). For holds_with_limits and fails, list in refutedBy the settled (verified or refuted) findings that show which part is wrong. The target finding is marked refuted unless the outcome is holds; the narrowed claim becomes a new finding and is independently verified.",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("holds"), Type.Literal("holds_with_limits"), Type.Literal("fails")]),
			summary: Type.String({ description: "Which sub-claims held and which were refuted, with finding ids" }),
			narrowedClaim: Type.Optional(Type.String({ description: "The claim that survives, stated so it can be checked on its own" })),
			evidence: Type.Optional(Type.String({ description: "For the narrowed claim: setup and numbers, citing the finding ids it rests on" })),
			sources: Type.Array(Type.String(), { description: "paperIds and finding ids the verdict rests on", minItems: 1 }),
			refutedBy: Type.Optional(Type.Array(Type.String(), { description: "Settled finding ids showing which part is wrong (required unless holds)" })),
		}),
		async execute(_id, p) {
			if (verdictRecorded(topic, focus)) throw new Error("The focus verdict was already recorded.");
			// Validate the saved state, not the agent's intentions: it must already hold the verdict.
			const state = readFileSync(focus.state, "utf8");
			if (!/^## Verdict/m.test(state)) throw new Error("Save your final state with ## Verdict (state_write) before calling focus_verdict.");
			const untagged = scopeProblems(state);
			if (untagged.length) {
				throw new Error(
					`These items are left untested without an allowed reason; tag each with one of ${SCOPE_TAGS.map((t) => `[${t}]`).join(" ")} if the tools truly cannot test it, otherwise create tasks for them:\n${untagged.map((l) => `  ${l}`).join("\n")}`,
				);
			}
			const tasks = listTasks(topic.tasks);
			if (!tasks.some((t) => t.focus === focus.key && t.type !== "verify" && t.status === "done")) {
				throw new Error(
					"No research task has finished in this focus yet. Test the open sub-claims first; deferred questions that paper_search or python_run can answer are in scope.",
				);
			}
			if (p.outcome === "holds_with_limits" && !p.narrowedClaim) throw new Error("holds_with_limits needs the narrowedClaim that survives.");
			const loaded = new Map(loadFindings(topic).map((f) => [f.id, f]));
			if (p.outcome !== "holds") {
				const ids = (p.refutedBy ?? []).filter((id) => id !== focus.findingId);
				const bad = ids.filter((id) => !loaded.has(id) || loaded.get(id)!.status === "unverified");
				if (!ids.length || bad.length) {
					throw new Error(
						`${p.outcome} needs refutedBy: settled (verified or refuted) findings, other than the target, showing which part is wrong${bad.length ? `; not settled or unknown: ${bad.join(", ")}` : ""}. If nothing in the claim is refuted, the outcome is holds.`,
					);
				}
			}
			// A verdict may not rest on findings that are unverified but can still be checked.
			const cited = [...new Set([...claimTreeIds(state), ...p.sources, ...(p.refutedBy ?? []), ...(`${p.summary} ${p.evidence ?? ""}`.match(/f-[0-9a-f]{8}/g) ?? [])])];
			const pending = verificationPending(topic, cited.filter((id) => id !== focus.findingId), focus.key);
			if (pending.length) {
				const queued = requeueVerification(topic, { addresses: pending, focus: focus.key });
				throw new Error(
					`The verdict cites unverified findings: ${pending.join(", ")}${queued.length ? ` (re-verification queued for ${queued.join(", ")})` : " (verification already queued)"}. Remove ## Verdict from your state and end this epoch; write the verdict again once they are settled.`,
				);
			}
			const all = readFindings(topic.ledger);
			const target =
				focus.findingId ??
				(all.find((f) => f.author === by && f.claim === focus.target) ??
					appendFinding(topic.ledger, { author: by, kind: "insight", role: "focus-target", claim: focus.target, evidence: p.summary, sources: p.sources, status: "unverified" })).id;
			appendVerification(topic.verifications, {
				findingId: target,
				check: "adversarial",
				verdict: p.outcome === "holds" ? "pass" : "fail",
				rationale: `Focus ${focus.key} verdict: ${p.outcome}. ${p.summary}`,
				sources: p.sources,
				by,
			});
			let narrowed = "";
			if (p.narrowedClaim) {
				// A narrowed gap is still a gap: no computation to rerun.
				const f = appendFinding(topic.ledger, {
					author: by,
					kind: loaded.get(target)?.kind ?? "insight",
					claim: p.narrowedClaim,
					evidence: p.evidence ?? p.summary,
					sources: p.sources,
					status: "unverified",
				});
				createTask(topic.tasks, `Verify ${f.id}`, f.claim, { type: "verify", findingId: f.id, focus: focus.key });
				narrowed = ` Narrowed claim recorded as ${f.id}; verification queued.`;
			}
			return text(`Recorded ${p.outcome} on ${target}.${narrowed}`);
		},
	});
}

/** Orchestrator memory between epochs; the cap keeps every epoch's prompt small. */
export const STATE_CAP = 6000;

export function stateTool(topic: TopicPaths, path = topic.orchestratorState): ToolDefinition {
	return defineTool({
		name: "state_write",
		label: "Write orchestrator state",
		description: `Replace the orchestrator state file (your only memory next epoch). Max ${STATE_CAP} characters; longer content is rejected, so condense.`,
		parameters: Type.Object({ content: Type.String() }),
		async execute(_id, p) {
			if (p.content.length > STATE_CAP) {
				throw new Error(`State is ${p.content.length} chars; limit is ${STATE_CAP}. Condense (drop stale detail, merge items) and retry.`);
			}
			writeFileSync(path, p.content);
			return text(`Saved state (${p.content.length}/${STATE_CAP} chars).`);
		},
	});
}

/** With `focus`, created tasks are tagged with it and task_list shows only that focus run's tasks. */
export function taskTools(topic: TopicPaths, focus?: string) {
	const create = defineTool({
		name: "task_create",
		label: "Create task",
		description:
			"Create a research task for a subagent. Make it narrow and self-contained: one sub-area or question. If the task follows up on verifier objections, list those finding ids in `addresses`; they are re-verified when the task finishes.",
		parameters: Type.Object({
			title: Type.String(),
			description: Type.String({ description: "What to investigate, what output is expected, and any leads" }),
			addresses: Type.Optional(Type.Array(Type.String(), { description: "Finding ids whose objections this task resolves" })),
		}),
		async execute(_id, p) {
			const known = new Set(readFindings(topic.ledger).map((f) => f.id));
			const unknown = (p.addresses ?? []).filter((id) => !known.has(id));
			if (unknown.length) throw new Error(`Unknown finding id(s): ${unknown.join(", ")}`);
			const addresses = p.addresses?.length ? p.addresses : undefined;
			return text(`Created ${createTask(topic.tasks, p.title, p.description, { addresses, focus }).id}.`);
		},
	});
	const list = defineTool({
		name: "task_list",
		label: "List tasks",
		description: `List open and claimed tasks, plus the ${DONE_SHOWN} most recent done tasks (titles only). Pass all=true for every done task.`,
		parameters: Type.Object({ all: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			const ts = listTasks(topic.tasks).filter((t) => t.focus === focus);
			if (!ts.length) return text("No tasks.");
			const active = ts.filter((t) => t.status !== "done");
			const done = ts.filter((t) => t.status === "done");
			const shownDone = p.all ? done : done.slice(-DONE_SHOWN);
			const line = (t: (typeof ts)[number]) => `${t.id} [${t.status}] ${t.title}`;
			return text(
				[
					`${active.length} open/claimed, ${done.length} done${shownDone.length < done.length ? ` (showing last ${shownDone.length})` : ""}.`,
					...active.map(line),
					...shownDone.map(line),
				].join("\n"),
			);
		},
	});
	return { create, list };
}
