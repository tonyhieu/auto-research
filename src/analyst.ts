// The analyst: an LLM principal investigator that reads a topic's state and returns one
// next action. parseAction/validateAction are pure and tested; makeAnalyst is the glue
// that calls the model and falls back to idle on invalid output.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent.ts";
import type { Finding } from "./ledger.ts";
import { type Action, type DriverConfig, verifiedNovelIds } from "./portfolio.ts";
import type { TopicRecord } from "./portfolio.ts";
import { parseReportName } from "./reports.ts";
import { ledgerTools } from "./tools.ts";
import type { Decider } from "./driver.ts";
import type { TopicPaths } from "./topic.ts";

const HYPOTHESIS_CAP = 1000;

/** The last JSON object carrying an `action` key in the model's reply. */
export function parseAction(text: string): unknown {
	const objects: string[] = [];
	// Walk brace-balanced spans so a JSON block anywhere in the reply is found, fences or not.
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
			if (o && typeof o === "object" && "action" in o) return o;
		} catch {
			// not JSON; keep scanning
		}
	}
	return undefined;
}

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
