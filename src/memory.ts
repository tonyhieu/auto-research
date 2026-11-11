import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFindings, readVerifications, type Finding, type Verification } from "./ledger.ts";
import type { TopicPaths } from "./topic.ts";

// Writes go through the pi memory system's own add.py with --root pointed at the
// topic's .pi/memory, so entries match ~/memory's format without touching it.
const ADD_PY = process.env.MEMORY_ADD_SCRIPT ?? join(homedir(), "memory", "scripts", "add.py");

interface Entry {
	slug: string;
	title: string;
	type: "project" | "research";
	tags: string[];
	content: string;
	status?: "active" | "archived";
}

function writeEntry(root: string, e: Entry): string | undefined {
	const r = spawnSync(
		"uv",
		["run", ADD_PY, "--root", root, "--slug", e.slug, "--title", e.title, "--type", e.type, "--status", e.status ?? "active", "--tags", e.tags.join(","), "--content-stdin"],
		{ input: e.content, encoding: "utf8", timeout: 120_000 },
	);
	if (r.error) return String(r.error);
	if (r.status !== 0) return (r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300);
	return undefined;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);

export function insightSlug(topic: TopicPaths, f: Finding): string {
	return `${topic.slug}-${f.id}`;
}

function insightEntry(topic: TopicPaths, f: Finding, vs: Verification[]): Entry {
	const checks = vs.map((v) => `- **${v.check}: ${v.verdict}** (${v.by}, ${v.ts.slice(0, 10)}): ${v.rationale}`).join("\n");
	return {
		slug: insightSlug(topic, f),
		title: `Insight (${topic.title}): ${clip(f.claim, 90)}`,
		type: "research",
		tags: [topic.slug, "auto-research", "verified", "novel", f.kind ?? "insight"],
		content: `# ${f.claim}

Verified and novel finding \`${f.id}\` from the auto-research topic "${topic.title}" (by ${f.author}, ${f.ts.slice(0, 10)}).

## Evidence
${f.evidence}

## Sources
${f.sources.map((s) => `- ${s}`).join("\n")}

## Verification
${checks}`,
	};
}

export interface PromotionResult {
	written: string[];
	errors: string[];
}

/**
 * Promote settled results into topic memory: one entry per verified+novel finding (written once),
 * and a digest entry refreshed from the latest window report. Entries whose finding is no longer
 * verified+novel (later refuted or found known) are rewritten once as archived, with the current verdicts.
 */
export function promoteToMemory(topic: TopicPaths, reportPath?: string): PromotionResult {
	const out: PromotionResult = { written: [], errors: [] };
	if (!existsSync(ADD_PY)) {
		out.errors.push(`memory script not found: ${ADD_PY}`);
		return out;
	}
	const vs = readVerifications(topic.verifications);
	const findings = loadFindings(topic);
	const insights = findings.filter((f) => f.status === "verified" && f.novelty === "novel");
	for (const f of insights) {
		const slug = insightSlug(topic, f);
		const file = join(topic.memory, `${slug}.md`);
		// Written once; an archived entry comes back if the finding is verified+novel again.
		if (existsSync(file) && !/^status: archived$/m.test(readFileSync(file, "utf8"))) continue;
		const err = writeEntry(topic.memory, insightEntry(topic, f, vs.filter((v) => v.findingId === f.id)));
		if (err) out.errors.push(`${slug}: ${err}`);
		else out.written.push(slug);
	}
	for (const f of findings) {
		const file = join(topic.memory, `${insightSlug(topic, f)}.md`);
		if (insights.includes(f) || !existsSync(file) || /^status: archived$/m.test(readFileSync(file, "utf8"))) continue;
		const e = insightEntry(topic, f, vs.filter((v) => v.findingId === f.id));
		const now = `${f.status}${f.novelty ? `, ${f.novelty}` : ", novelty inconclusive"}`;
		const entry: Entry = {
			...e,
			status: "archived",
			title: `Superseded (${now}): ${clip(f.claim, 80)}`,
			tags: [topic.slug, "auto-research", "superseded", f.kind ?? "insight"],
			content: `**Superseded: this finding is now ${now}; see the verification section for why.**\n\n${e.content}`,
		};
		const err = writeEntry(topic.memory, entry);
		if (err) out.errors.push(`${entry.slug}: ${err}`);
		else out.written.push(`${entry.slug} (archived)`);
	}

	if (reportPath && existsSync(reportPath)) {
		const count = (pred: (f: Finding) => boolean) => findings.filter(pred).length;
		const digest: Entry = {
			slug: `${topic.slug}-digest`,
			title: `Auto-research digest: ${topic.title}`,
			type: "project",
			tags: [topic.slug, "auto-research", "digest"],
			content: `Latest window report for the auto-research topic "${topic.title}" (copied from \`${reportPath}\`).
Ledger: ${findings.length} findings; ${count((f) => f.status === "verified")} verified (${insights.length} novel), ${count((f) => f.status === "refuted")} refuted.
Verified novel insights have their own entries: ${insights.map((f) => `\`${insightSlug(topic, f)}\``).join(", ") || "none yet"}.

${readFileSync(reportPath, "utf8").trim()}`,
		};
		const err = writeEntry(topic.memory, digest);
		if (err) out.errors.push(`${digest.slug}: ${err}`);
		else out.written.push(digest.slug);
	}
	return out;
}
