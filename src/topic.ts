import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "..");

export interface TopicPaths {
	slug: string;
	title: string;
	dir: string;
	memory: string;
	state: string;
	orchestratorState: string;
	ledger: string;
	/** Append-only verdicts; finding status is derived from these. */
	verifications: string;
	tasks: string;
	notes: string;
	reports: string;
	/** Optional user-written starting point (goals, context, leads, constraints). */
	brief: string;
}

export function slugify(topic: string): string {
	return topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Create (idempotently) the on-disk layout for a topic. */
export function ensureTopic(title: string, root = join(REPO_ROOT, "topics")): TopicPaths {
	const slug = slugify(title);
	const dir = join(root, slug);
	const p: TopicPaths = {
		slug,
		title,
		dir,
		memory: join(dir, ".pi", "memory"),
		state: join(dir, "state"),
		orchestratorState: join(dir, "state", "orchestrator.md"),
		ledger: join(dir, "ledger.jsonl"),
		verifications: join(dir, "verifications.jsonl"),
		tasks: join(dir, "tasks"),
		notes: join(dir, "notes"),
		reports: join(dir, "reports"),
		brief: join(dir, "brief.md"),
	};
	for (const d of [p.memory, p.state, p.tasks, p.notes, p.reports]) mkdirSync(d, { recursive: true });
	for (const f of [p.ledger, p.verifications]) if (!existsSync(f)) writeFileSync(f, "");
	if (!existsSync(p.orchestratorState)) {
		writeFileSync(p.orchestratorState, `# Orchestrator state: ${title}\n\n(no epochs run yet)\n`);
	}
	return p;
}

/** Briefs go into every agent's system prompt, so keep them bounded. */
export const BRIEF_CAP = 12_000;

/** The topic's research brief, or "" when none was given. */
export function readBrief(t: TopicPaths): string {
	return existsSync(t.brief) ? readFileSync(t.brief, "utf8").trim() : "";
}

const pidAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by another user
	}
};

/** Create the lock file with our pid atomically; false if a live process holds it. A stale lock is replaced once. */
export function acquireLock(path: string, retry = true): boolean {
	try {
		writeFileSync(path, String(process.pid), { flag: "wx" });
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	if (!retry || pidAlive(Number(readFileSync(path, "utf8")))) return false;
	unlinkSync(path);
	return acquireLock(path, false);
}
