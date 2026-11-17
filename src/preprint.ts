// Pre-print writer: preprint -t "Topic" -f <finding id> [-k <focus key>] [-o out.md]
// Summarizes one finding and its linked findings into pre-prints/<slug>/pre-print-<datetime>.md.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent.ts";
import { claimTreeIds, FINDING_ID, type Focus } from "./focus.ts";
import { focusTaskIds, listTasks, loadFindings } from "./ledger.ts";
import { preprintPrompt, preprintSystem } from "./prompts.ts";
import { setPaperCache } from "./s2.ts";
import { ledgerTools, s2Paper } from "./tools.ts";
import { ensureTopic, REPO_ROOT, slugify } from "./topic.ts";

const MODEL = "claude-opus-5-5";

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
	options: {
		topic: { type: "string", short: "t" },
		finding: { type: "string", short: "f" },
		focus: { type: "string", short: "k" },
		out: { type: "string", short: "o" },
	},
});
const fail = (msg: string): never => {
	console.error(msg);
	process.exit(2);
};
if (!values.topic || !values.finding) fail('usage: preprint -t "Topic" -f <finding id> [-k <focus key>] [-o out.md]');
// ensureTopic would create a typo'd topic, so check it exists first.
if (!existsSync(join(REPO_ROOT, "topics", slugify(values.topic!)))) fail(`no topic ${slugify(values.topic!)}`);
const topic = ensureTopic(values.topic!);

const all = loadFindings(topic);
const main = all.find((f) => f.id === values.finding) ?? fail(`finding ${values.finding} is not in ${topic.ledger}`);

let focus: (Omit<Focus, "state"> & { state: string }) | undefined;
if (values.focus) {
	const file = join(topic.state, "focus.json");
	let entries: Omit<Focus, "state">[] = [];
	try {
		if (existsSync(file)) entries = JSON.parse(readFileSync(file, "utf8"));
	} catch (e) {
		fail(`cannot parse ${file}: ${(e as Error).message}`);
	}
	const f = entries.find((x) => x.key === values.focus) ?? fail(`focus ${values.focus} is not in ${file}`);
	focus = { ...f, state: join(topic.state, `focus-${f.key}.md`) };
}

// Related: the focus target (if narrowed), references, citing findings, and the focus run's own findings.
const focusTasks = focus ? focusTaskIds(listTasks(topic.tasks), focus.key) : new Set<string>();
const relatedIds = new Set([
	...(focus?.findingId ? [focus.findingId] : []),
	...main.sources.filter((s) => FINDING_ID.test(s)),
	...all.filter((f) => f.sources.includes(main.id)).map((f) => f.id),
	...(focus && existsSync(focus.state) ? claimTreeIds(readFileSync(focus.state, "utf8")) : []),
	...all.filter((f) => f.taskId && focusTasks.has(f.taskId)).map((f) => f.id),
]);
relatedIds.delete(main.id);
const related = all.filter((f) => relatedIds.has(f.id));

const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "");
const out = resolve(values.out ?? join(REPO_ROOT, "pre-prints", topic.slug, `pre-print-${stamp}.md`));
mkdirSync(dirname(out), { recursive: true });
setPaperCache(topic.papers);

const log = (line: string) => console.log(`${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`);
log(`pre-print of ${main.id} with ${related.length} related finding(s) -> ${out}`);
const lt = ledgerTools(topic, "preprint");
const r = await runAgent({
	name: "preprint",
	// Writes are confined to cwd, so the agent can only write into the pre-print's directory.
	cwd: dirname(out),
	model: MODEL,
	systemPrompt: preprintSystem(topic),
	prompt: preprintPrompt({ path: out, slug: topic.slug, main, related, focus }),
	builtinTools: ["read", "write", "ls"],
	tools: [lt.list, lt.get, s2Paper],
	models: await ModelRuntime.create(),
	log,
});
log(`[preprint] ${r.tokens.total} tokens, ${r.toolCalls} tool calls`);
if (r.interrupted || !existsSync(out)) {
	console.error(r.interrupted ? `interrupted: ${r.interrupted}` : "the agent did not write the pre-print");
	process.exit(1);
}
log(`pre-print written: ${out}`);
