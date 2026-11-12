import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent as realRunAgent, VERIFIER_MODEL, type AgentResult } from "./agent.ts";
import { Budget, sameWindow, WEEKLY_STOP } from "./budget.ts";
import {
	claimNextTask,
	createTask,
	enqueueVerifyTasks,
	listTasks,
	loadFindings,
	openObjections,
	readFindings,
	reproducible,
	readVerifications,
	releaseTask,
	requeueVerification,
	updateTask,
	type Task,
} from "./ledger.ts";
import type { Focus } from "./focus.ts";
import {
	focusOrchestratorSystem,
	focusSummaryPrompt,
	orchestratorPrompt,
	orchestratorSystem,
	subagentPrompt,
	subagentSystem,
	summaryPrompt,
	summarySystem,
	verifierPrompt,
	verifierSystem,
} from "./prompts.ts";
import { promoteToMemory } from "./memory.ts";
import { ensureSandboxImage } from "./sandbox.ts";
import type { TopicPaths } from "./topic.ts";
import { BASE_CHECKS, focusVerdictTool, ledgerTools, makePythonTool, s2Paper, s2Search, searchTool, stateTool, taskTools, verifyTool } from "./tools.ts";
import type { UsageProbe } from "./usage.ts";

/** Re-plan after this many subagent completions, even if open tasks remain. */
const EPOCH_TASKS = 6;
/** Task note marking a verify task retried because its verifier recorded nothing. */
const NO_VERDICT_NOTE = "Previous verifier recorded no verdicts.";
/** Wait this long past the reported reset before resuming. */
const RESET_GRACE_MS = 60_000;
/** python_run cap in focus mode, where verifiers rerun full experiments. */
const FOCUS_PYTHON_SEC = 900;
/** Total python_run wall time per agent, so one agent cannot hold a slot for hours. */
const SANDBOX_BUDGET_SEC = 20 * 60;
const FOCUS_SANDBOX_BUDGET_SEC = 45 * 60;

export interface ControllerOptions {
	topic: TopicPaths;
	models: ModelRuntime;
	usage: UsageProbe;
	windows: number;
	concurrency: number;
	log: (line: string) => void;
	/** Depth mode: test one hypothesis instead of surveying the topic. */
	focus?: Focus;
	/** Test seams: fake agents, clock, and sandbox for the window/budget loop. */
	run?: typeof realRunAgent;
	sleep?: (ms: number) => Promise<void>;
	sandboxCheck?: () => string | undefined;
	promote?: typeof promoteToMemory;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface EpochRecord {
	epoch: number;
	ts: string;
	tasksCreated: number;
	stateUpdated: boolean;
	interrupted?: string;
	focus?: string;
}

const epochsFile = (t: TopicPaths) => join(t.state, "epochs.jsonl");

function lastEpoch(t: TopicPaths): EpochRecord | undefined {
	if (!existsSync(epochsFile(t))) return undefined;
	const lines = readFileSync(epochsFile(t), "utf8").trim().split("\n").filter(Boolean);
	for (const l of lines.reverse()) {
		try {
			return JSON.parse(l) as EpochRecord;
		} catch {
			// skip a truncated line
		}
	}
	return undefined;
}

function appendEpoch(t: TopicPaths, e: EpochRecord): void {
	appendFileSync(epochsFile(t), JSON.stringify(e) + "\n");
}

export async function runController(o: ControllerOptions): Promise<void> {
	const { topic, models, log, focus } = o;
	const runAgent = o.run ?? realRunAgent;
	const sleep = o.sleep ?? realSleep;
	const promote = o.promote ?? promoteToMemory;
	const budget = new Budget();
	const hardAbort = new AbortController();

	// python_run is offered only when Docker works; research still runs without it.
	const sandboxError = (o.sandboxCheck ?? ensureSandboxImage)();
	// Focus mode exists to rerun experiments, so it needs the sandbox.
	if (sandboxError && focus) {
		log(`error: focus mode needs python_run, but ${sandboxError}`);
		return;
	}
	if (sandboxError) log(`warning: ${sandboxError}; python_run disabled`);
	/** A fresh python_run per agent, so each agent gets its own sandbox time budget. */
	const sandboxLimits = focus ? { maxSec: FOCUS_PYTHON_SEC, budgetSec: FOCUS_SANDBOX_BUDGET_SEC } : { maxSec: 300, budgetSec: SANDBOX_BUDGET_SEC };
	const compute = (onRun?: (sec: number) => void) => (sandboxError ? [] : [makePythonTool({ ...sandboxLimits, onRun })]);
	const sandboxLine = (sec: number) => (sec ? `; sandbox ${Math.round(sec)}s` : "");
	const stateFile = focus?.state ?? topic.orchestratorState;
	/** Set once the focus outcome is written back to the ledger (focus_verdict). */
	let verdictRecorded = false;
	const verdictTool = focus && focusVerdictTool(topic, focus, () => (verdictRecorded = true));
	/** Tasks belonging to this run's mode: the focus run's own, or untagged breadth tasks. */
	const inScope = (t: Task) => t.focus === focus?.key;

	const refreshFromEndpoint = async () => {
		const s = await o.usage.read(1);
		if (s) {
			budget.update({
				fiveHour: s.sessionPercent,
				fiveHourReset: s.sessionResetsAt.getTime(),
				weekly: s.weeklyPercent,
			});
		} else log(`usage endpoint unavailable (${o.usage.lastError}); relying on response headers`);
	};

	const common = {
		cwd: topic.dir,
		models,
		log,
		signal: hardAbort.signal,
		onResponse: (_status: number, headers: Record<string, string>) => {
			budget.fromHeaders(headers);
			if (budget.weeklyHardCapHit() && !hardAbort.signal.aborted) {
				log(`weekly cap reached (${budget.describe()}); aborting all agents`);
				hardAbort.abort();
			}
		},
		shouldStop: () => (budget.snap.rejected ? "usage window exhausted" : undefined),
	};

	const orchestrate = async (nudge = "") => {
		const last = lastEpoch(topic);
		const epoch = (last?.epoch ?? 0) + 1;
		const before = readFileSync(stateFile, "utf8");
		copyFileSync(stateFile, stateFile.replace(/\.md$/, ".prev.md"));
		const tasksBefore = listTasks(topic.tasks).length;
		const lt = ledgerTools(topic, "orchestrator");
		const tt = taskTools(topic, focus?.key);
		const target = focus?.findingId ? loadFindings(topic).find((f) => f.id === focus.findingId) : undefined;
		const targetVerdicts = readVerifications(topic.verifications).filter((v) => v.findingId === target?.id);
		const tasks = listTasks(topic.tasks).filter(inScope);
		const findings = focus ? readFindings(topic.ledger).filter((f) => tasks.some((t) => t.id === f.taskId)) : readFindings(topic.ledger);
		// No generic write: state goes through state_write so the size cap holds.
		const r = await runAgent({
			...common,
			name: "orchestrator",
			systemPrompt: focus ? focusOrchestratorSystem(topic, focus, target, targetVerdicts) : orchestratorSystem(topic),
			prompt:
				orchestratorPrompt({
					epoch,
					state: before,
					since: last?.ts,
					findings,
					tasks,
					objections: openObjections(topic, 8, focus),
				}) + nudge,
			builtinTools: ["read", "ls"],
			tools: [
				s2Search,
				s2Paper,
				lt.list,
				lt.get,
				tt.create,
				tt.list,
				stateTool(topic, stateFile),
				...(verdictTool ? [verdictTool] : []),
			],
		});
		const stateUpdated = readFileSync(stateFile, "utf8") !== before;
		if (!stateUpdated && !r.interrupted) log("warning: orchestrator did not update its state file this epoch");
		appendEpoch(topic, {
			epoch,
			ts: new Date().toISOString(),
			tasksCreated: listTasks(topic.tasks).length - tasksBefore,
			stateUpdated,
			interrupted: r.interrupted,
			...(focus ? { focus: focus.key } : {}),
		});
		return r;
	};

	const research = async (task: Task, name: string): Promise<AgentResult> => {
		let sandboxSec = 0;
		const r = await runAgent({
			...common,
			name,
			systemPrompt: subagentSystem(topic, !!focus),
			prompt: subagentPrompt(task),
			builtinTools: ["read", "write", "ls"],
			tools: [s2Search, s2Paper, ...Object.values(ledgerTools(topic, name, task.id)), ...compute((s) => (sandboxSec += s))],
		});
		finish(task, name, r, sandboxLine(sandboxSec));
		const queued = enqueueVerifyTasks(topic, focus?.key);
		if (queued) log(`queued ${queued} verify task(s)`);
		if (!r.interrupted && task.addresses?.length) {
			const again = requeueVerification(topic, task);
			if (again.length) log(`re-verifying ${again.join(", ")} after follow-up ${task.id}`);
		}
		return r;
	};

	const verify = async (task: Task, name: string): Promise<AgentResult> => {
		const finding = readFindings(topic.ledger).find((f) => f.id === task.findingId);
		if (!finding) {
			updateTask(topic.tasks, { ...task, status: "done", notes: [...(task.notes ?? []), "finding not found"] });
			return { text: "", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, toolCalls: 0 };
		}
		const lt = ledgerTools(topic, name);
		// No write tools: a verifier only records verdicts for its one finding.
		const prior = readVerifications(topic.verifications).filter((v) => v.findingId === finding.id);
		const followUps = listTasks(topic.tasks).filter((t) => t.status === "done" && t.addresses?.includes(finding.id));
		// Focus verifiers also rerun the experiment, and get no file access so the rerun is independent.
		const rerun = !!focus && reproducible(finding);
		const checks = rerun ? [...BASE_CHECKS, "reproduce" as const] : BASE_CHECKS;
		const retry = task.notes?.includes(NO_VERDICT_NOTE)
			? "\n\nA previous verifier stopped without recording any verdict. You must record every check with verify_record."
			: "";
		let searches = 0;
		let runs = 0;
		let sandboxSec = 0;
		const py = compute((s) => {
			runs++;
			sandboxSec += s;
		});
		const r = await runAgent({
			...common,
			name,
			model: VERIFIER_MODEL,
			systemPrompt: verifierSystem(topic, rerun),
			prompt: verifierPrompt(finding, prior, followUps) + retry,
			builtinTools: focus ? [] : ["read", "ls"],
			tools: [
				searchTool(() => searches++),
				s2Paper,
				lt.list,
				lt.get,
				verifyTool(topic, finding.id, name, () => searches, checks, () => runs),
				...py,
			],
		});
		const verdicts = readVerifications(topic.verifications).filter((v) => v.findingId === finding.id).slice(prior.length);
		const eff = loadFindings(topic).find((f) => f.id === finding.id);
		log(`[${name}] ${finding.id} -> ${eff?.status}${eff?.novelty ? `, ${eff.novelty}` : ""} (${verdicts.map((v) => `${v.check}=${v.verdict}`).join(" ")}; ${searches} searches)`);
		// A verifier that quits without any verdict gets one retry; otherwise the finding is never checked.
		if (!r.interrupted && verdicts.length === 0 && !retry) {
			log(`warning: ${name} recorded no verdicts for ${finding.id}; re-queued once`);
			releaseTask(topic.tasks, task, NO_VERDICT_NOTE);
			log(`[${name}] released; ${usageLine(r)}${sandboxLine(sandboxSec)}`);
			return r;
		}
		if (!r.interrupted && verdicts.length === 0) log(`warning: ${name} recorded no verdicts for ${finding.id} on retry; giving up`);
		finish(task, name, r, sandboxLine(sandboxSec));
		return r;
	};

	const finish = (task: Task, name: string, r: AgentResult, extra = "") => {
		if (r.interrupted) {
			const n = readFindings(topic.ledger).filter((f) => f.taskId === task.id).length;
			releaseTask(topic.tasks, task, `${name} interrupted (${r.interrupted}) after recording ${n} finding(s).`);
		} else updateTask(topic.tasks, { ...task, status: "done" });
		log(`[${name}] ${r.interrupted ? `interrupted: ${r.interrupted}` : "done"}; ${usageLine(r)}${extra}`);
	};

	/** Token breakdown plus current subscription reading, logged after every agent. */
	const usageLine = (r: AgentResult) => {
		const k = (n: number) => `${(n / 1000).toFixed(0)}k`;
		const t = r.tokens;
		return `${r.toolCalls} tool calls; tokens ${k(t.total)} (in ${k(t.input)}, out ${k(t.output)}, cache read ${k(t.cacheRead)}, cache write ${k(t.cacheWrite)}); usage ${budget.describe()}`;
	};

	const nudgeText = () =>
		`\n\n# Note\nLast epoch created no tasks, so the run would end now with usage at ${budget.describe()}. ` +
		(focus
			? "No ## Verdict has been written: create tasks that test the sub-claims still open."
			: "Do not declare the topic complete while budget remains: go deeper on the strongest leads (replications, ablations, stress tests).") +
		" Create no tasks only if nothing is left that is worth testing.";

	/** Unverified findings cited in the focus claim tree. */
	const unsettledCited = () => {
		const s = readFileSync(stateFile, "utf8");
		const tree = s.split(/^## /m).find((x) => x.startsWith("Claim tree")) ?? s;
		const status = new Map(loadFindings(topic).map((f) => [f.id, f.status]));
		return [...new Set(tree.match(/f-[0-9a-f]{8}/g) ?? [])].filter((id) => status.get(id) === "unverified");
	};
	const verdictNudge = (unsettled: string[], queued: string[], unrecorded: boolean) =>
		"\n\n# Note\n" +
		(unsettled.length
			? `Your verdict rests on findings that are still unverified: ${unsettled.join(", ")}. ` +
				(queued.length ? `Re-verification is queued for ${queued.join(", ")}. ` : "") +
				`Usage is at ${budget.describe()}. Remove "## Verdict" from your state, and create tasks that settle these findings ` +
				"and any open question you deferred that paper_search or python_run can answer. Write the verdict again only once they are settled. "
			: "") +
		(unrecorded
			? "You wrote ## Verdict but focus_verdict did not record it, so the ledger still shows the old status. " +
				(focusResearchDone() === 0
					? "No research task has run in this focus yet: remove ## Verdict and create tasks that test the open sub-claims and deferred questions."
					: "Call it with the final outcome.")
			: "");
	const focusResearchDone = () => listTasks(topic.tasks).filter((t) => inScope(t) && t.type !== "verify" && t.status === "done").length;

	let windowStart = new Date().toISOString();
	const summarize = async (windowNo: number) => {
		const report = join("reports", `${windowStart.slice(0, 16).replace(/:/g, "")}${focus ? `-${focus.key}` : ""}-w${windowNo}.md`);
		log(`writing summary ${report}`);
		const r = await runAgent({
			...common,
			// Summaries run on whatever budget is left; only the hard weekly cap stops them.
			shouldStop: undefined,
			name: "summary",
			systemPrompt: summarySystem(topic, join("state", stateFile.split("/").at(-1)!)),
			prompt: focus ? focusSummaryPrompt(report, focus) : summaryPrompt(report, windowStart),
			builtinTools: ["read", "write", "ls"],
			tools: [ledgerTools(topic, "summary").list, ledgerTools(topic, "summary").get],
		});
		const reportPath = join(topic.dir, report);
		const wrote = existsSync(reportPath);
		if (r.interrupted) log(`summary interrupted: ${r.interrupted}`);
		else log(wrote ? `summary written: ${reportPath}` : "warning: summary agent did not write the report");
		log(`[summary] ${usageLine(r)}`);
		// Promotion is deterministic (no LLM): verified+novel findings and the report digest.
		const p = promote(topic, wrote ? reportPath : undefined);
		if (p.written.length) log(`topic memory updated: ${p.written.join(", ")}`);
		for (const e of p.errors) log(`warning: memory promotion failed: ${e}`);
	};

	await refreshFromEndpoint();
	log(`start: ${budget.describe()}`);
	// Covers findings from before verification existed or from a crashed run.
	const backlog = enqueueVerifyTasks(topic, focus?.key);
	if (backlog) log(`queued ${backlog} verify task(s) for unverified findings`);
	// A focus on an existing finding starts by rerunning it independently.
	if (focus?.findingId && !listTasks(topic.tasks).some((t) => inScope(t) && t.findingId === focus.findingId)) {
		const f = readFindings(topic.ledger).find((x) => x.id === focus.findingId);
		if (f) createTask(topic.tasks, `Reproduce ${f.id}`, f.claim, { type: "verify", findingId: f.id, focus: focus.key });
		log(`focus ${focus.key}: queued independent reproduction of ${focus.findingId}`);
	}

	/** Window whose summary could not run because the window was exhausted. */
	let pendingSummary: number | undefined;
	let noMoreWork = false;
	/** An epoch that creates no tasks gets one nudged retry before the run ends; this is that nudge. */
	let nudge = "";
	/** A focus verdict is checked for unsettled findings once per run. */
	let verdictChecked = false;

	for (let windowNo = 1; windowNo <= o.windows; windowNo++) {
		let windowReset = budget.snap.fiveHourReset;
		let summarized = false;
		let sinceEpoch = Infinity; // forces an orchestrator epoch at window start
		let subCount = 0;
		let runningResearch = 0;
		const running = new Set<Promise<AgentResult>>();
		log(`window ${windowNo}/${o.windows} begins: ${budget.describe()}`);

		// Main fan-out loop for this window.
		for (;;) {
			// If startup had no usage reading, adopt the first reset time a response reports.
			windowReset ??= budget.snap.fiveHourReset;
			const state = budget.state();
			const rolledOver = windowReset !== undefined && !sameWindow(budget.snap.fiveHourReset, windowReset);
			if (state === "stop" || rolledOver || noMoreWork || hardAbort.signal.aborted) break;

			if (state === "wrap" && !summarized) {
				await Promise.all(running);
				await summarize(windowNo);
				summarized = true;
				continue;
			}

			const open = listTasks(topic.tasks).filter((t) => t.status === "open" && inScope(t));
			// Drain queued verifications before re-planning so the orchestrator sees their verdicts.
			const verifyQueued = open.some((t) => t.type === "verify");
			if (running.size === 0 && !verifyQueued && (!open.length || sinceEpoch >= EPOCH_TASKS)) {
				const r = await orchestrate(nudge);
				log(`[orchestrator] ${r.interrupted ?? "done"}; ${usageLine(r)}\n${r.text}`);
				sinceEpoch = 0;
				const wasNudged = nudge !== "";
				nudge = "";
				const empty = !r.interrupted && !listTasks(topic.tasks).some((t) => t.status === "open" && inScope(t));
				const verdict = !!focus && /^## Verdict/m.test(readFileSync(stateFile, "utf8"));
				const unsettled = empty && verdict && !verdictChecked ? unsettledCited() : [];
				const unrecorded = empty && verdict && !verdictChecked && !verdictRecorded;
				if (empty && verdict) verdictChecked = true;
				if (unsettled.length || unrecorded) {
					// Send the orchestrator back once: re-verify cited unverified findings, and/or ask for focus_verdict.
					const queued = unsettled.length ? requeueVerification(topic, { addresses: unsettled, focus: focus?.key }) : [];
					if (unsettled.length) log(`focus verdict cites unverified ${unsettled.join(", ")}; re-verifying ${queued.join(", ") || "none (attempts used)"}`);
					if (unrecorded) log("focus verdict written but not recorded with focus_verdict; sending back");
					nudge = verdictNudge(unsettled, queued, unrecorded);
				} else if (empty && (wasNudged || verdict)) {
					log(verdict ? "focus verdict written; ending run" : "orchestrator created no tasks twice; ending run");
					noMoreWork = true;
				} else if (empty) {
					log("orchestrator created no tasks; retrying once with a budget nudge");
					nudge = nudgeText();
				}
				continue;
			}

			// Fill free slots. Verify tasks go first and do not count toward the epoch boundary;
			// research stops being claimed once the epoch's quota is in flight.
			while (running.size < o.concurrency) {
				const researchRoom = sinceEpoch + runningResearch < EPOCH_TASKS;
				const claimed = claimNextTask(topic.tasks, "pending", (t) => inScope(t) && (t.type === "verify" || researchRoom));
				if (!claimed) break;
				const isVerify = claimed.type === "verify";
				const name = `${isVerify ? "ver" : "sub"}-${++subCount}`;
				const task = { ...claimed, assignee: name };
				updateTask(topic.tasks, task);
				log(`[${name}] claimed ${task.id}: ${task.title}`);
				if (!isVerify) runningResearch++;
				const p = (isVerify ? verify(task, name) : research(task, name)).finally(() => {
					running.delete(p);
					if (!isVerify) {
						runningResearch--;
						sinceEpoch++;
					}
				});
				running.add(p);
			}
			if (running.size === 0) continue; // nothing claimable: loop back to orchestrate
			await Promise.race(running);
		}

		await Promise.all(running);
		const peak = budget.peakFor(windowReset);
		log(`window ${windowNo} ends: ${budget.describe()}; peak 5h utilization this window ${peak === undefined ? "?" : `${peak.toFixed(0)}%`}`);
		if (!summarized) {
			// An exhausted window cannot run the summary; do it first thing next window.
			if (budget.snap.rejected) pendingSummary = windowNo;
			else await summarize(windowNo);
		}

		// The weekly cap does not reset with the 5h window, so it ends the whole run.
		if (hardAbort.signal.aborted || noMoreWork || (budget.snap.weekly ?? 0) >= WEEKLY_STOP) break;
		if (windowNo === o.windows && pendingSummary === undefined) break;

		// Sleep until the window resets (skip if it already rolled over).
		const reset = budget.snap.fiveHourReset;
		const wait = reset ? reset + RESET_GRACE_MS - Date.now() : 0;
		if (reset !== undefined && sameWindow(reset, windowReset) && wait > 0) {
			log(`sleeping ${(wait / 60_000).toFixed(0)} min until ${new Date(reset + RESET_GRACE_MS).toISOString()}`);
			await sleep(wait);
		}
		// A new window: drop the old window's readings and re-read the starting utilization.
		budget.startNewWindow();
		await refreshFromEndpoint();
		if (pendingSummary !== undefined) {
			await summarize(pendingSummary);
			pendingSummary = undefined;
		}
		if (windowNo === o.windows) break;
		windowStart = new Date().toISOString();
	}
	log(`run complete: ${budget.describe()}; ${readFindings(topic.ledger).length} findings in ledger`);
}
