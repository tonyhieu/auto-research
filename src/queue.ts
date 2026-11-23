// Human brief queue: drop a Markdown brief in briefs/queue/ and the driver starts that topic
// before consulting the selector. Processed briefs move to queue/done or queue/rejected.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO_ROOT } from "./topic.ts";

export const QUEUE_DIR = join(REPO_ROOT, "briefs", "queue");

export interface QueuedBrief {
	title: string;
	brief: string;
	file: string;
}

/** The oldest *.md dropped directly in the queue dir; subfolders (done/, rejected/) are ignored. */
export function nextQueuedBrief(dir: string = QUEUE_DIR): QueuedBrief | undefined {
	if (!existsSync(dir)) return undefined;
	const files = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".md"))
		.map((e) => e.name)
		.sort();
	if (!files.length) return undefined;
	const file = join(dir, files[0]);
	const brief = readFileSync(file, "utf8");
	// Title from the first H1, else the filename de-slugified.
	const h1 = brief.match(/^#\s+(.+)$/m);
	const title = (h1?.[1] ?? basename(files[0], ".md").replace(/[-_]+/g, " ")).trim();
	return { title, brief, file };
}

/** Move a processed brief out of the queue so the next cycle does not pick it up again. */
export function archiveBrief(file: string, status: "done" | "rejected", note?: string): void {
	const dir = join(file, "..", status);
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, basename(file));
	renameSync(file, dest);
	if (note) writeFileSync(`${dest}.reason.txt`, `${note}\n`);
}
