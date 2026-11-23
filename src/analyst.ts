// The analyst: an LLM principal investigator that reads a topic's state and returns one
// next action. parseAction/validateAction are pure and tested; makeAnalyst is the glue
// that calls the model and falls back to idle on invalid output.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent.ts";
import type { Finding } from "./ledger.ts";
import { type Action, type DriverConfig, type SelectDecision, verifiedNovelIds } from "./portfolio.ts";
import type { TopicRecord } from "./portfolio.ts";
import { parseReportName } from "./reports.ts";
import { validateBrief } from "./brief.ts";
import { ledgerTools } from "./tools.ts";
import type { Decider } from "./driver.ts";
import { REPO_ROOT, type TopicPaths } from "./topic.ts";

const HYPOTHESIS_CAP = 1000;

/** The last brace-balanced JSON object carrying `key`, scanning the reply fences or not. */
function lastJsonObject(text: string, key: string): Record<string, unknown> | undefined {
	const objects: string[] = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		let depth = 0;
		for (let j = i; j < text.length; j++) {
			if (text[j] === "{") depth++;
			else if (text[j] === "}" && --depth === 0) {
				objects.push(text.slice(i, j + 1));
				i = j;
				break;
			}
		}
	}
	for (const s of objects.reverse()) {
		try {
			const o = JSON.parse(s);
			if (o && typeof o === "object" && key in o) return o as Record<string, unknown>;
		} catch {
			// not JSON; keep scanning
		}
	}
	return undefined;
}

export const parseAction = (text: string): Record<string, unknown> | undefined => lastJsonObject(text, "action");
export const parseSelect = (text: string): Record<string, unknown> | undefined => lastJsonObject(text, "decision");

type Valid = { ok: true; action: Action; rationale: string } | { ok: false; error: string };

export function validateAction(raw: unknown, ctx: { findings: Finding[]; cfg: DriverConfig }): Valid {
	if (!raw || typeof raw !== "object") return { ok: false, error: "no JSON action object found" };
	const o = raw as Record<string, unknown>;
	const a = o.action as Record<string, unknown> | undefined;
	if (!a || typeof a !== "object") return { ok: false, error: "missing action object" };
	const rationale = typeof o.rationale === "string" ? o.rationale : "";
	const windows = Number.isInteger(a.windows) && (a.windows as number) >= 1 ? (a.windows as number) : ctx.cfg.windows;
	const byId = new Map(ctx.findings.map((f) => [f.id, f]));
	switch (a.kind) {
		case "breadth":
			return { ok: true, action: { kind: "breadth", windows }, rationale };
		case "focus": {
			const findingId = typeof a.findingId === "string" ? a.findingId : undefined;
			const hypothesis = typeof a.hypothesis === "string" ? a.hypothesis.trim() : undefined;
			if (findingId && !byId.has(findingId)) return { ok: false, error: `focus findingId ${findingId} not in ledger` };
			if (!findingId && !hypothesis) return { ok: false, error: "focus needs a findingId or a hypothesis" };
			if (hypothesis && hypothesis.length > HYPOTHESIS_CAP) return { ok: false, error: `hypothesis exceeds ${HYPOTHESIS_CAP} chars` };
			return { ok: true, action: { kind: "focus", windows, ...(findingId ? { findingId } : { hypothesis }) }, rationale };
		}
		case "preprint": {
			const findingId = typeof a.findingId === "string" ? a.findingId : "";
			const f = byId.get(findingId);
			if (!f) return { ok: false, error: `preprint findingId ${findingId || "(missing)"} not in ledger` };
			if (!(f.status === "verified" && f.novelty === "novel")) return { ok: false, error: `preprint ${findingId} is not verified+novel` };
			return { ok: true, action: { kind: "preprint", findingId }, rationale };
		}
		case "retire": {
			const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim() : "";
			if (!reason) return { ok: false, error: "retire needs a reason" };
			return { ok: true, action: { kind: "retire", reason }, rationale };
		}
		case "idle": {
			const minutes = Number.isInteger(a.minutes) && (a.minutes as number) >= 1 ? Math.min(a.minutes as number, 240) : ctx.cfg.idleMinutes;
			const reason = typeof a.reason === "string" ? a.reason : "analyst idle";
			return { ok: true, action: { kind: "idle", minutes, reason }, rationale };
		}
		default:
			return { ok: false, error: `unknown action kind ${JSON.stringify(a.kind)}` };
	}
}

// Portfolio-level roaming: pick which topic to advance, or propose a new one.
export interface SelectContext {
	summary: string;
	existing: { slug: string; title: string }[];
	cfg: DriverConfig;
}
export type Selector = (ctx: SelectContext) => Promise<{ decision: SelectDecision; rationale: string }>;

type SelectValid = { ok: true; decision: SelectDecision; rationale: string } | { ok: false; error: string };

export function validateSelect(raw: Record<string, unknown> | undefined, ctx: { existing: { slug: string; title: string }[]; cfg: DriverConfig }): SelectValid {
	if (!raw) return { ok: false, error: "no JSON decision object found" };
	const d = raw.decision as Record<string, unknown> | undefined;
	if (!d || typeof d !== "object") return { ok: false, error: "missing decision object" };
	const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
	switch (d.kind) {
		case "work": {
			const slug = typeof d.slug === "string" ? d.slug : "";
			if (!ctx.existing.some((t) => t.slug === slug)) return { ok: false, error: `work slug ${slug || "(missing)"} is not an existing topic` };
			return { ok: true, decision: { kind: "work", slug }, rationale };
		}
		case "new-topic": {
			const title = typeof d.title === "string" ? d.title : "";
			const area = typeof d.area === "string" && d.area.trim() ? d.area.trim() : "default";
			const v = validateBrief(title, typeof d.brief === "string" ? d.brief : "", ctx.existing);
			if (!v.ok) return { ok: false, error: v.error };
			return { ok: true, decision: { kind: "new-topic", title: title.trim(), area, brief: v.brief }, rationale };
		}
		case "idle": {
			const minutes = Number.isInteger(d.minutes) && (d.minutes as number) >= 1 ? Math.min(d.minutes as number, 240) : ctx.cfg.idleMinutes;
			return { ok: true, decision: { kind: "idle", minutes, reason: typeof d.reason === "string" ? d.reason : "selector idle" }, rationale };
		}
		case "stop":
			return { ok: true, decision: { kind: "stop", reason: typeof d.reason === "string" ? d.reason : "selector stop" }, rationale };
		default:
			return { ok: false, error: `unknown decision kind ${JSON.stringify(d.kind)}` };
	}
}

function selectSystem(): string {
	return `You are the RESEARCH DIRECTOR choosing what an autonomous harness works on next across a portfolio of topics.

Strategy: deepen-then-roam. Keep advancing a topic (breadth, focus, pre-print) while it still has a worthwhile next step. Open a sibling topic in the same area when the current one is exhausted but the area is not. Only propose a wholly new area once the current area is mined out.

Hard constraint: the CPU sandbox has numpy/scipy/sympy/scikit-learn (no torch) and only two datasets, 20 Newsgroups and UCI Covertype. Every topic, new or old, must be answerable with those or pure simulation. A new topic's brief has its constraints section replaced by the canonical one automatically; write the question, prior work, and method, and keep the data within these limits.

Decisions (choose exactly one):
- work: advance an existing topic (give its slug); the per-topic analyst then picks the exact action.
- new-topic: propose a topic with a title, an area, and a brief (question, prior work, method).
- idle: nothing worth running now; wait.
- stop: shut the driver down.

Reply with exactly one JSON object and nothing else:
{"decision": {"kind": "...", ...fields}, "rationale": "one sentence"}`;
}

const selectPrompt = (summary: string): string =>
	`Portfolio (areas, topics, status, verified-novel counts):
${summary}

New topics only after the current area is exhausted; at most modest branching. Keep every topic inside the sandbox limits. Decide the single next move and reply with the JSON object.`;

export function makeSelector(models: ModelRuntime, log: (line: string) => void = () => {}): Selector {
	return async ({ summary, existing, cfg }) => {
		const cwd = join(REPO_ROOT, "topics");
		for (let attempt = 0; attempt < 2; attempt++) {
			const prompt = attempt === 0 ? selectPrompt(summary) : `${selectPrompt(summary)}\n\nYour previous reply was not a single valid JSON decision. Reply with exactly one JSON object and nothing else.`;
			let text = "";
			try {
				const r = await runAgent({ name: "selector", cwd, systemPrompt: selectSystem(), prompt, builtinTools: ["read", "ls"], tools: [], models, log });
				text = r.text;
				if (r.interrupted) log(`[selector] interrupted: ${r.interrupted}`);
			} catch (e) {
				log(`[selector] error: ${(e as Error).message}`);
			}
			const v = validateSelect(parseSelect(text), { existing, cfg });
			if (v.ok) return { decision: v.decision, rationale: v.rationale };
			log(`[selector] invalid decision: ${v.error}`);
		}
		return { decision: { kind: "idle", minutes: cfg.idleMinutes, reason: "selector produced no valid decision" }, rationale: "fallback after invalid selector output" };
	};
}

function latestReport(topic: TopicPaths): string {
	if (!existsSync(topic.reports)) return "";
	const reports = readdirSync(topic.reports)
		.filter((n) => parseReportName(n))
		.map((n) => ({ n, t: statSync(join(topic.reports, n)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	return reports.length ? readFileSync(join(topic.reports, reports[0].n), "utf8") : "";
}

function stats(findings: Finding[]): string {
	const by = (p: (f: Finding) => boolean) => findings.filter(p).length;
	const vn = findings.filter((f) => f.status === "verified" && f.novelty === "novel");
	const vnList = vn.map((f) => `${f.id} ${f.title || f.claim.slice(0, 60)}`).join("\n  ") || "(none)";
	return [
		`findings: ${findings.length}`,
		`verified: ${by((f) => f.status === "verified")} (novel ${vn.length}, known ${by((f) => f.status === "verified" && f.novelty === "known")})`,
		`refuted: ${by((f) => f.status === "refuted")}  unverified: ${by((f) => f.status === "unverified")}`,
		`verified+novel findings:\n  ${vnList}`,
	].join("\n");
}

function analystSystem(): string {
	return `You are the PRINCIPAL INVESTIGATOR driving an autonomous research harness. You do not run experiments; you decide the single next action for one topic and nothing else.

Objective: reach findings that are VERIFIED and NOVEL, where the novelty verdict is "pass", not merely "inconclusive". Treat inconclusive-novelty as weak. A verified+novel finding is a milestone, not a finish: deepen it with focus runs, then commission a pre-print once it holds up.

Hard constraint: the CPU sandbox has numpy/scipy/sympy/scikit-learn (no torch) and only two datasets, 20 Newsgroups and UCI Covertype. Never propose work that needs other data, GPUs, or real LLMs.

Guardrails: do not grind one claim; after several focus runs with no payoff, switch to breadth or retire. Retire only when the topic has been deepened and nothing worthwhile remains.

Actions (choose exactly one):
- breadth: another exploration window.
- focus: deepen one claim, by findingId (a verified+novel finding to stress-test) or a short hypothesis string.
- preprint: write a pre-print for a verified+novel finding that has held up.
- retire: stop work on this topic.
- idle: nothing worth running now; wait.

Reply with exactly one JSON object and nothing else:
{"action": {"kind": "...", ...fields}, "rationale": "one sentence"}`;
}

function analystPrompt(topic: TopicPaths, rec: TopicRecord, cfg: DriverConfig, findings: Finding[]): string {
	const report = latestReport(topic);
	return `Topic "${topic.title}" (area ${rec.area}, status ${rec.status}).
Runs so far: ${rec.runs}. Consecutive focus runs: ${rec.consecutiveFocus} (cap ${cfg.maxConsecutiveFocus}). Barren runs in a row: ${rec.consecutiveBarrenRuns}.
Already deepened: ${rec.deepened.join(", ") || "none"}. Already pre-printed: ${rec.preprinted.join(", ") || "none"}.

Ledger stats:
${stats(findings)}

Use ledger_list and ledger_get to inspect findings before deciding. The latest window report follows.
---
${report.slice(0, 8000) || "(no report yet)"}
---
Decide the single best next action and reply with the JSON object.`;
}

export function makeAnalyst(models: ModelRuntime, log: (line: string) => void = () => {}): Decider {
	return async ({ findings, rec, cfg, topic }) => {
		const lt = ledgerTools(topic, "analyst");
		const base = analystPrompt(topic, rec, cfg, findings);
		for (let attempt = 0; attempt < 2; attempt++) {
			const prompt = attempt === 0 ? base : `${base}\n\nYour previous reply was not a single valid JSON action. Reply with exactly one JSON object and nothing else.`;
			let text = "";
			try {
				const r = await runAgent({ name: "analyst", cwd: topic.dir, systemPrompt: analystSystem(), prompt, builtinTools: ["read", "ls"], tools: [lt.list, lt.get], models, log });
				text = r.text;
				if (r.interrupted) log(`[analyst] interrupted: ${r.interrupted}`);
			} catch (e) {
				log(`[analyst] error: ${(e as Error).message}`);
			}
			const v = validateAction(parseAction(text), { findings, cfg });
			if (v.ok) return { action: v.action, rationale: v.rationale || rec.slug };
			log(`[analyst] invalid action: ${v.error}`);
		}
		return { action: { kind: "idle", minutes: cfg.idleMinutes, reason: "analyst produced no valid action" }, rationale: "fallback after invalid analyst output" };
	};
}

// vn is handy for callers shaping prompts/snapshots.
export { verifiedNovelIds };
