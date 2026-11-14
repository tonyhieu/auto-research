// One-off: mark legacy free-text focus targets with role "focus-target" so breadth runs skip verifying refuted ones.
// Usage: tsx scripts/backfill-focus-targets.ts topics/<slug> [--apply]. Dry run without --apply; refuses while a run holds the lock.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listTasks, type Finding } from "../src/ledger.ts";

const [dir, flag] = process.argv.slice(2);
if (!dir) throw new Error("usage: tsx scripts/backfill-focus-targets.ts topics/<slug> [--apply]");
const apply = flag === "--apply";
if (apply && existsSync(join(dir, ".lock"))) throw new Error(`${dir}/.lock exists; stop the run first`);

const ledger = join(dir, "ledger.jsonl");
const covered = new Set(listTasks(join(dir, "tasks")).map((t) => t.findingId));
const marked: string[] = [];
const parse = (l: string) => { try { return JSON.parse(l) as Finding; } catch { return undefined; } };
// Rewrite matching lines only; every other line (including unparseable ones) is kept byte for byte.
const lines = readFileSync(ledger, "utf8").split("\n").map((l) => {
	const f = l.trim() ? parse(l) : undefined;
	if (!f || f.role || !f.author.startsWith("focus-") || f.taskId || covered.has(f.id)) return l;
	marked.push(f.id);
	return JSON.stringify({ ...f, role: "focus-target" });
});
console.log(`${marked.length} focus target(s): ${marked.join(", ") || "none"}`);
if (apply && marked.length) {
	writeFileSync(`${ledger}.tmp`, lines.join("\n"));
	renameSync(`${ledger}.tmp`, ledger);
	console.log("ledger updated");
}
