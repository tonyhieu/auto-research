// Report regenerator: regen-report -t "Topic" -r <report name>
// Reruns the summary agent for reports/<name> against the current ledger. The old version moves to
// reports/.history/, since topics/ is not in git.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent.ts";
import type { Focus } from "./focus.ts";
import { readFindings } from "./ledger.ts";
import { focusSummaryPrompt, summaryPrompt, summarySystem } from "./prompts.ts";
import { citedIds, parseReportName, regenerateNote } from "./reports.ts";
import { setPaperCache } from "./s2.ts";
import { ledgerTools } from "./tools.ts";
import { ensureTopic, REPO_ROOT, slugify } from "./topic.ts";

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({ options: { topic: { type: "string", short: "t" }, report: { type: "string", short: "r" } } });
const fail = (msg: string): never => {
	console.error(msg);
	process.exit(2);
};
if (!values.topic || !values.report) fail('usage: regen-report -t "Topic" -r <report name>');
// ensureTopic would create a typo'd topic, so check it exists first.
if (!existsSync(join(REPO_ROOT, "topics", slugify(values.topic!)))) fail(`no topic ${slugify(values.topic!)}`);
const topic = ensureTopic(values.topic!);

const name = values.report!;
const parsed = parseReportName(name) ?? fail(`not a window report name: ${name}`);
const reportPath = join(topic.reports, name);
if (!existsSync(reportPath)) fail(`no report ${reportPath}`);

let focus: Focus | undefined;
if (parsed.focusKey) {
	const file = join(topic.state, "focus.json");
	let entries: Omit<Focus, "state">[] = [];
	try {
		entries = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		fail(`cannot parse ${file}: ${(e as Error).message}`);
	}
	const f = entries.find((x) => x.key === parsed.focusKey) ?? fail(`focus ${parsed.focusKey} is not in ${file}`);
	focus = { ...f, state: join(topic.state, `focus-${f.key}.md`) };
}
const stateFile = focus ? `state/focus-${focus.key}.md` : "state/orchestrator.md";

const old = readFileSync(reportPath, "utf8");
const writtenAt = statSync(reportPath).mtime.toISOString();
const known = new Set(readFindings(topic.ledger).map((f) => f.id));
const cited = citedIds(old);
const missing = cited.filter((id) => !known.has(id));

// The agent writes a draft outside reports/, so a failed run leaves the old report in place.
const draft = join(".regen", name);
rmSync(join(topic.dir, draft), { force: true });
mkdirSync(join(topic.dir, ".regen"), { recursive: true });
setPaperCache(topic.papers);

const log = (line: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`);
log(`regenerating ${name} (written ${writtenAt}; ${cited.length} cited, ${missing.length} deleted)`);
const lt = ledgerTools(topic, "summary");
const r = await runAgent({
	name: "summary",
	cwd: topic.dir,
	systemPrompt: summarySystem(topic, stateFile),
	prompt: (focus ? focusSummaryPrompt(draft, focus) : summaryPrompt(draft, parsed.since)) + regenerateNote(writtenAt, cited, missing),
	builtinTools: ["read", "write", "ls"],
	tools: [lt.list, lt.get],
	models: await ModelRuntime.create(),
	log,
});
log(`[summary] ${r.tokens.total} tokens, ${r.toolCalls} tool calls`);
if (r.interrupted || !existsSync(join(topic.dir, draft))) {
	console.error(r.interrupted ? `interrupted: ${r.interrupted}` : "the agent did not write the report");
	process.exit(1);
}
const history = join(topic.reports, ".history");
mkdirSync(history, { recursive: true });
const kept = join(history, `${name.replace(/\.md$/, "")}.${writtenAt.replace(/[:.]/g, "-")}.md`);
renameSync(reportPath, kept);
renameSync(join(topic.dir, draft), reportPath);
log(`report regenerated: ${reportPath} (previous version: ${kept})`);
