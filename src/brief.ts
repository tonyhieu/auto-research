// Brief drafting support for analyst-proposed topics: force the canonical sandbox constraints
// (so a drafted brief cannot invent datasets), enforce the length cap, and reject near-duplicates.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_CAP, REPO_ROOT, slugify } from "./topic.ts";

const CONSTRAINTS_FILE = join(REPO_ROOT, "briefs", "_constraints.md");

export function canonicalConstraints(): string {
	return existsSync(CONSTRAINTS_FILE) ? readFileSync(CONSTRAINTS_FILE, "utf8").trim() : "## Constraints\n\n(constraints file missing)";
}

/** Drop any Constraints section the analyst wrote and append the canonical one, so data claims cannot drift. */
export function withCanonicalConstraints(brief: string): string {
	const body = brief.split(/^## Constraints\b.*$/m)[0].trimEnd();
	return `${body}\n\n${canonicalConstraints()}\n`;
}

const titleWords = (s: string) => new Set(slugify(s).split("-").filter((w) => w.length > 2));

/** Jaccard overlap of title words; cheap guard against the analyst re-proposing a known topic. */
function similar(a: string, b: string): number {
	const x = titleWords(a);
	const y = titleWords(b);
	if (!x.size || !y.size) return 0;
	let shared = 0;
	for (const w of x) if (y.has(w)) shared++;
	return shared / (x.size + y.size - shared);
}

/** The slug of an existing topic this proposal duplicates, or undefined. */
export function duplicateOf(title: string, existing: { slug: string; title: string }[]): string | undefined {
	const slug = slugify(title);
	const hit = existing.find((t) => t.slug === slug || similar(title, t.title) >= 0.6);
	return hit?.slug;
}

export type BriefCheck = { ok: true; brief: string; slug: string } | { ok: false; error: string };

export function validateBrief(title: string, brief: string, existing: { slug: string; title: string }[]): BriefCheck {
	const t = title.trim();
	if (!t) return { ok: false, error: "new topic needs a title" };
	const dup = duplicateOf(t, existing);
	if (dup) return { ok: false, error: `too close to existing topic ${dup}; continue it or pick a distinct angle` };
	const full = withCanonicalConstraints(brief.trim());
	if (full.length > BRIEF_CAP) return { ok: false, error: `brief is ${full.length} chars; limit is ${BRIEF_CAP}` };
	if (brief.trim().length < 200) return { ok: false, error: "brief is too thin; give a question, prior work, and a method" };
	return { ok: true, brief: full, slug: slugify(t) };
}
