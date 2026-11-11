import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TopicPaths } from "./topic.ts";

/** A depth run testing one hypothesis: a finding id or free text. */
export interface Focus {
	key: string;
	target: string;
	/** Set when the target is a ledger finding id. */
	findingId?: string;
	started: string;
	/** Orchestrator state (claim tree) for this focus, separate from the breadth state. */
	state: string;
}

export const FINDING_ID = /^f-[0-9a-f]{8}$/;

/** The only accepted reasons to leave a question untested: things no agent tool can do. */
export const SCOPE_TAGS = ["needs-full-text", "needs-gpu", "needs-real-llm", "needs-external-data", "needs-human"];
const TAG = new RegExp(`\\[(${SCOPE_TAGS.join("|")})\\]`);

const section = (state: string, name: string) => state.split(/^## /m).find((s) => s.startsWith(name)) ?? "";

/**
 * Lines that leave work untested without an allowed reason: claim-tree entries marked out of scope, and
 * open-question bullets, that lack a SCOPE_TAGS tag. Anything else is testable and must be tested.
 */
export function scopeProblems(state: string): string[] {
	const lines = (s: string) => s.split("\n").slice(1).map((l) => l.trim());
	const tree = lines(section(state, "Claim tree")).filter((l) => /out of scope/i.test(l));
	const open = lines(section(state, "Open questions")).filter((l) => l.startsWith("-"));
	return [...tree, ...open].filter((l) => !TAG.test(l));
}

/** Reuse the focus with the same target (so a later run continues its claim tree), else start a new one. */
export function resolveFocus(topic: TopicPaths, target: string): Focus {
	const file = join(topic.state, "focus.json");
	let all: Omit<Focus, "state">[] = [];
	if (existsSync(file)) {
		// Fail loudly: resetting a corrupt file would orphan existing claim trees.
		try {
			all = JSON.parse(readFileSync(file, "utf8"));
		} catch (e) {
			throw new Error(`cannot parse ${file}: ${(e as Error).message}`);
		}
	}
	let f = all.find((x) => x.target === target);
	if (!f) {
		f = {
			key: `fx-${randomUUID().slice(0, 8)}`,
			target,
			...(FINDING_ID.test(target) ? { findingId: target } : {}),
			started: new Date().toISOString(),
		};
		all.push(f);
		writeFileSync(file, JSON.stringify(all, null, 2));
	}
	const state = join(topic.state, `focus-${f.key}.md`);
	if (!existsSync(state)) writeFileSync(state, `# Focus state: ${target}\n\n(no epochs run yet)\n`);
	return { ...f, state };
}
