import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runController } from "./controller.ts";
import { FINDING_ID, resolveFocus } from "./focus.ts";
import { readFindings, resetStaleClaims } from "./ledger.ts";
import { killAllSandboxes } from "./sandbox.ts";
import { acquireLock, BRIEF_CAP, ensureTopic, readBrief, REPO_ROOT } from "./topic.ts";
import { UsageProbe } from "./usage.ts";

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
	options: {
		topic: { type: "string", short: "t" },
		windows: { type: "string", short: "n", default: "1" },
		concurrency: { type: "string", short: "c", default: "3" },
		brief: { type: "string", short: "b" },
		focus: { type: "string", short: "f" },
	},
});
const windows = Number(values.windows);
const concurrency = Number(values.concurrency);
if (!values.topic || !(windows >= 1) || !(concurrency >= 1)) {
	console.error('usage: research -t "Topic" [-n windows] [-c concurrent subagents] [-b brief.md] [-f <finding id> | -f "hypothesis"]');
	process.exit(2);
}

const topic = ensureTopic(values.topic);

// A brief is saved into the topic, so later runs reuse it; passing -b again replaces it.
if (values.brief) {
	if (!existsSync(values.brief)) {
		console.error(`brief not found: ${values.brief}`);
		process.exit(2);
	}
	const brief = readFileSync(values.brief, "utf8").trim();
	if (brief.length > BRIEF_CAP) {
		console.error(`brief is ${brief.length} chars; limit is ${BRIEF_CAP} (it goes into every agent's prompt)`);
		process.exit(2);
	}
	writeFileSync(topic.brief, brief + "\n");
}

// Focus (depth mode): one hypothesis, tested until each sub-claim is settled.
const target = values.focus?.trim();
if (target !== undefined && !target) {
	console.error("-f needs a finding id or a hypothesis");
	process.exit(2);
}
if (target && FINDING_ID.test(target) && !readFindings(topic.ledger).some((f) => f.id === target)) {
	console.error(`finding ${target} is not in ${topic.ledger}`);
	process.exit(2);
}

// One process per topic: task claiming relies on it.
const lock = join(topic.dir, ".lock");
if (!acquireLock(lock)) {
	console.error(`topic "${topic.slug}" is already running (pid ${readFileSync(lock, "utf8")})`);
	process.exit(1);
}
// Sync only: the exit handler cannot await, and sandbox kill timers die with the process.
process.on("exit", () => {
	killAllSandboxes();
	if (existsSync(lock)) unlinkSync(lock);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

mkdirSync(join(topic.dir, "logs"), { recursive: true });
const logFile = join(topic.dir, "logs", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
const log = (line: string) => {
	const out = `${new Date().toISOString().slice(0, 19).replace("T", " ")} ${line}`;
	console.log(out);
	appendFileSync(logFile, out + "\n");
};

log(`topic=${topic.slug} windows=${windows} concurrency=${concurrency} log=${logFile}`);
const focus = target ? resolveFocus(topic, target) : undefined;
if (focus) log(`focus ${focus.key} (started ${focus.started}): ${focus.target}; state ${focus.state}`);
const brief = readBrief(topic);
log(brief ? `brief: ${topic.brief} (${brief.length} chars)` : "brief: none (agents see only the topic title; pass -b brief.md)");
const stale = resetStaleClaims(topic.tasks);
if (stale) log(`re-opened ${stale} task(s) left claimed by a previous run`);

const models = await ModelRuntime.create();
await runController({ topic, models, usage: new UsageProbe(models), windows, concurrency, log, focus });
