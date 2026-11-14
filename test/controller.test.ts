import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentResult, AgentSpec } from "../src/agent.ts";
import { runController } from "../src/controller.ts";
import { appendFinding, appendVerification, createTask, listTasks, updateTask } from "../src/ledger.ts";
import { ensureTopic, type TopicPaths } from "../src/topic.ts";
import type { UsageProbe } from "../src/usage.ts";
import { resolveFocus, type Focus } from "../src/focus.ts";

/**
 * Fake agents: each provider "response" adds `step` percent to the 5h window.
 * Hitting 100% returns a rejected status, like the real subscription.
 */
function harness(opts: {
	step: number;
	weeklyStep?: number;
	windows: number;
	silentVerifiers?: boolean;
	/** Tasks the fake orchestrator creates per epoch, by epoch index (default 3 every epoch). */
	tasksPerEpoch?: (epoch: number) => number;
	/** Builds the focus once the harness topic exists. */
	focus?: (t: TopicPaths) => Focus;
	/** Called after each fake orchestrator epoch (e.g. to write a verdict). */
	onOrchestrate?: (epoch: number, spec: AgentSpec) => void | Promise<void>;
}) {
	const logs: string[] = [];
	const topic = ensureTopic("ctl", mkdtempSync(join(tmpdir(), "ar-ctl-")));
	const focus = opts.focus?.(topic);
	let now = Date.parse("2026-01-01T00:00:00Z");
	let five = 0;
	let weekly = 0;
	let reset = now + 5 * 3600_000;
	const calls: string[] = [];
	const sleeps: number[] = [];
	const promotions: (string | undefined)[] = [];

	const weeklyAtSummary: number[] = [];
	const specs: AgentSpec[] = [];
	let epochs = 0;
	const run = async (spec: AgentSpec): Promise<AgentResult> => {
		calls.push(spec.name);
		specs.push(spec);
		if (spec.name === "summary") weeklyAtSummary.push(weekly);
		if (spec.name === "orchestrator") {
			const n = opts.tasksPerEpoch?.(epochs) ?? 3;
			for (let i = 0; i < n; i++) createTask(topic.tasks, `task ${i}`, "d", { focus: focus?.key });
			await opts.onOrchestrate?.(epochs, spec);
			epochs++;
		}
		const fid = /^Verify finding (f-\S+)/.exec(spec.prompt)?.[1];
		if (fid && !opts.silentVerifiers) {
			appendVerification(topic.verifications, { findingId: fid, check: "citation", verdict: "pass", rationale: "r", sources: [], by: spec.name });
		}
		const respond = () => {
			five = Math.min(100, five + opts.step);
			weekly += opts.weeklyStep ?? 0;
			const rejected = five >= 100;
			spec.onResponse?.(rejected ? 429 : 200, {
				"anthropic-ratelimit-unified-5h-utilization": String(five / 100),
				"anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
				"anthropic-ratelimit-unified-5h-status": rejected ? "rejected" : "allowed",
				"anthropic-ratelimit-unified-7d-utilization": String(weekly / 100),
			});
		};
		respond();
		const interrupted = spec.signal?.aborted ? "aborted" : spec.shouldStop?.();
		return { text: "ok", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, toolCalls: 0, interrupted };
	};
	const sleep = async (ms: number) => {
		sleeps.push(ms);
		calls.push("SLEEP");
		now += ms;
		five = 0;
		reset = now + 5 * 3600_000;
	};
	const usage = { read: async () => undefined, lastError: "test" } as unknown as UsageProbe;
	const realNow = Date.now;
	Date.now = () => now;
	const go = () =>
		runController({
			topic,
			models: {} as ModelRuntime,
			usage,
			windows: opts.windows,
			concurrency: 2,
			log: (l) => logs.push(l),
			focus,
			run,
			sleep,
			sandboxCheck: () => undefined,
			promote: (_t, report) => {
				promotions.push(report);
				return { written: [], errors: [] };
			},
		}).finally(() => (Date.now = realNow));
	return { topic, focus, calls, specs, sleeps, weeklyAtSummary, promotions, logs, go };
}

test("two windows: summary each window, one sleep until reset, then resume", async () => {
	const h = harness({ step: 12, windows: 2 });
	await h.go();
	const summaries = h.calls.filter((c) => c === "summary").length;
	assert.equal(summaries, 2, `calls: ${h.calls.join(",")}`);
	assert.equal(h.sleeps.length, 1);
	// Sleep is until reset + grace, i.e. roughly 5h minus elapsed fake time.
	assert.ok(h.sleeps[0] > 0);
	// Research resumed after the reset, even though the usage endpoint gave no reading.
	const after = h.calls.slice(h.calls.indexOf("SLEEP") + 1);
	assert.ok(after.includes("orchestrator") && after.some((c) => c.startsWith("sub-")), `calls: ${h.calls.join(",")}`);
	assert.equal(after.at(-1), "summary");
	assert.equal(h.promotions.length, 2, "memory promotion after each window summary");
	assert.equal(listTasks(h.topic.tasks).filter((t) => t.status === "claimed").length, 0, "no tasks left claimed");
	// Epoch numbering persists on disk so a restarted run continues counting.
	const epochs = readFileSync(join(h.topic.state, "epochs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(epochs.map((e) => e.epoch), epochs.map((_, i) => i + 1));
	assert.equal(epochs[0].tasksCreated, 3);
	assert.ok(existsSync(join(h.topic.state, "orchestrator.prev.md")));
});

test("research findings get verified: verify task queued, claimed by a verifier, not counted as research", async () => {
	const h = harness({ step: 12, windows: 1 });

	appendFinding(h.topic.ledger, { author: "old", kind: "insight", claim: "x", evidence: "e", sources: ["p"], status: "unverified" });
	await h.go();
	const verifiers = h.calls.filter((c) => c.startsWith("ver-"));
	assert.equal(verifiers.length, 1, `calls: ${h.calls.join(",")}`);
	// The backlog verify task runs before the first orchestrator epoch, so it plans with the verdicts.
	assert.equal(h.calls[0], verifiers[0], `calls: ${h.calls.join(",")}`);
	assert.ok(h.calls.indexOf(verifiers[0]) < h.calls.findIndex((c) => c.startsWith("sub-")));
	const vt = listTasks(h.topic.tasks).find((t) => t.type === "verify");
	assert.equal(vt?.status, "done");
});

test("a verifier that records no verdicts is retried exactly once, with a note", async () => {
	const h = harness({ step: 12, windows: 1, silentVerifiers: true });
	appendFinding(h.topic.ledger, { author: "old", kind: "insight", claim: "x", evidence: "e", sources: ["p"], status: "unverified" });
	await h.go();
	assert.equal(h.calls.filter((c) => c.startsWith("ver-")).length, 2, `calls: ${h.calls.join(",")}`);
	const vt = listTasks(h.topic.tasks).find((t) => t.type === "verify");
	assert.equal(vt?.status, "done");
	assert.deepEqual(vt?.notes, ["Previous verifier recorded no verdicts."]);
	assert.equal(vt?.retries, 1);
	assert.ok(h.logs.some((l) => /re-queued once/.test(l)) && h.logs.some((l) => /on retry; giving up/.test(l)));
});

test("a legacy verify task with the no-verdict note and no retries field counts as retried", async () => {
	const h = harness({ step: 12, windows: 1, silentVerifiers: true });
	const f = appendFinding(h.topic.ledger, { author: "old", kind: "insight", claim: "x", evidence: "e", sources: ["p"], status: "unverified" });
	const t = createTask(h.topic.tasks, `Verify ${f.id}`, f.claim, { type: "verify", findingId: f.id });
	updateTask(h.topic.tasks, { ...t, notes: ["Previous verifier recorded no verdicts."] });
	await h.go();
	assert.equal(h.calls.filter((c) => c.startsWith("ver-")).length, 1, `calls: ${h.calls.join(",")}`);
	assert.equal(listTasks(h.topic.tasks).find((x) => x.id === t.id)?.status, "done");
	assert.ok(!h.logs.some((l) => /re-queued once/.test(l)) && h.logs.some((l) => /on retry; giving up/.test(l)));
});

test("logs per-agent token breakdown and the window's peak 5h utilization", async () => {
	const h = harness({ step: 12, windows: 1 });
	await h.go();
	assert.ok(h.logs.some((l) => /\] done; 0 tool calls; tokens 0k \(in 0k, out 0k, cache read 0k, cache write 0k\); usage 5h \d+%/.test(l)));
	const end = h.logs.find((l) => l.startsWith("window 1 ends"));
	assert.match(end ?? "", /peak 5h utilization this window (9[0-9]|100)%/);
});

test("weekly cap ends the run early without sleeping for the next window", async () => {
	const h = harness({ step: 1, weeklyStep: 1, windows: 3 });
	await h.go();
	assert.equal(h.sleeps.length, 0);
	// Summary runs at the 77% wrap point, before the 80% cap.
	assert.equal(h.weeklyAtSummary.length, 1, `calls: ${h.calls.join(",")}`);
	assert.ok(h.weeklyAtSummary[0] >= 77 && h.weeklyAtSummary[0] < 80);
	// Stops at 79%: about 79 responses, never reaching the cap.
	assert.ok(h.calls.length <= 81, `too many agent runs: ${h.calls.length}`);
});

test("window exhausted before wrap: summary deferred to after the reset", async () => {
	// Big jumps skip the 90% wrap point and go straight to rejected.
	const h = harness({ step: 45, windows: 1 });
	await h.go();
	assert.equal(h.sleeps.length, 1, "slept until reset to write the summary");
	assert.deepEqual(h.calls.slice(h.calls.indexOf("SLEEP")), ["SLEEP", "summary"], `calls: ${h.calls.join(",")}`);
});

test("breadth: an epoch with no tasks gets one nudged retry, then the run ends", async () => {
	const h = harness({ step: 5, windows: 1, tasksPerEpoch: (e) => (e === 0 ? 3 : 0) });
	await h.go();
	const orch = h.specs.filter((s) => s.name === "orchestrator");
	assert.equal(orch.length, 3, `calls: ${h.calls.join(",")}`);
	assert.ok(!orch[1].prompt.includes("Last epoch created no tasks"));
	assert.match(orch[2].prompt, /Last epoch created no tasks.*Do not declare the topic complete/s);
	assert.ok(h.logs.some((l) => /created no tasks twice; ending run/.test(l)));
});

test("epoch number and since are scoped to the run's mode", async () => {
	// A breadth, B focus (written once the focus key exists), C breadth with no `focus` field (legacy shape).
	const seed = (t: TopicPaths, key: string) =>
		writeFileSync(
			join(t.state, "epochs.jsonl"),
			[
				{ epoch: 1, ts: "2025-12-01T00:00:00.000Z", tasksCreated: 1, stateUpdated: true },
				{ epoch: 1, ts: "2025-12-02T00:00:00.000Z", tasksCreated: 1, stateUpdated: true, focus: key },
				{ epoch: 2, ts: "2025-12-03T00:00:00.000Z", tasksCreated: 1, stateUpdated: true },
			]
				.map((e) => JSON.stringify(e) + "\n")
				.join(""),
		);
	const firstPrompt = async (focus: boolean) => {
		const h = harness({
			step: 5,
			windows: 1,
			tasksPerEpoch: () => 0,
			focus: focus
				? (t) => {
						const f = resolveFocus(t, "free-text hypothesis");
						seed(t, f.key);
						return f;
					}
				: undefined,
		});
		if (!focus) seed(h.topic, "fx-other");
		await h.go();
		return h.specs.find((s) => s.name === "orchestrator")!.prompt;
	};
	const breadth = await firstPrompt(false);
	assert.match(breadth, /^Run orchestrator epoch 3 now/);
	assert.match(breadth, /since last epoch \(2025-12-03T00:00:00\.000Z\)/);
	const focus = await firstPrompt(true);
	assert.match(focus, /^Run orchestrator epoch 2 now/);
	assert.match(focus, /since last epoch \(2025-12-02T00:00:00\.000Z\)/);
});

test("focus: reproduces the target first, scopes tasks, verifier gets reproduce and no file tools, verdict ends run", async () => {
	const h = harness({
		step: 5,
		windows: 1,
		focus: (t) => {
			const f = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "target", evidence: "e", sources: ["p"], status: "unverified" });
			// A breadth task that the focus run must not claim.
			createTask(t.tasks, "breadth leftover", "d");
			return resolveFocus(t, f.id);
		},
		onOrchestrate: async (e, spec) => {
			if (e !== 1) return;
			writeFileSync(h.focus!.state, "## Claim tree\nC1 reproduced\n## Verdict\nholds");
			const tool = spec.tools.find((t) => t.name === "focus_verdict")!;
			await tool.execute("id", { outcome: "holds", summary: "C1 reproduced", sources: ["p"] } as never, undefined, undefined, {} as never);
		},
		tasksPerEpoch: (e) => (e === 0 ? 2 : 0),
	});
	await h.go();
	const tasks = listTasks(h.topic.tasks);
	const repro = tasks.find((t) => t.title.startsWith("Reproduce"));
	assert.equal(repro?.focus, h.focus!.key);
	assert.equal(h.calls[0], "ver-1", `reproduction runs before planning: ${h.calls.join(",")}`);
	const ver = h.specs.find((s) => s.name === "ver-1")!;
	assert.deepEqual(ver.builtinTools, []);
	assert.match(ver.systemPrompt, /4\. reproduce/);
	const orch = h.specs.find((s) => s.name === "orchestrator")!;
	assert.match(orch.systemPrompt, /FOCUS mode[\s\S]*Claim: target/);
	assert.equal(tasks.find((t) => t.title === "breadth leftover")?.status, "open", "breadth task untouched");
	assert.equal(h.specs.filter((s) => s.name === "orchestrator").length, 2, "verdict ends the run without a nudge");
	assert.ok(h.logs.some((l) => /focus verdict recorded; draining/.test(l)));
	assert.ok(h.specs.find((s) => s.name === "summary")?.prompt.includes("validity report"));
	assert.match(String(ver.tools.find((t) => t.name === "verify_record")?.description), /reproduce/, "insight gets reproduce");
});

test("focus: gap findings are verified without a reproduce check", async () => {
	const h = harness({
		step: 5,
		windows: 1,
		focus: (t) => {
			const f = appendFinding(t.ledger, { author: "a", kind: "gap", claim: "no paper does X", evidence: "e", sources: ["p"], status: "unverified" });
			return resolveFocus(t, f.id);
		},
		onOrchestrate: () => writeFileSync(h.focus!.state, "## Verdict\nholds"),
		tasksPerEpoch: () => 0,
	});
	await h.go();
	const ver = h.specs.find((s) => s.name === "ver-1")!;
	assert.doesNotMatch(ver.systemPrompt, /4\. reproduce/);
	assert.doesNotMatch(String(ver.tools.find((t) => t.name === "verify_record")?.description), /reproduce/);
});

test("focus mode refuses to run without the sandbox", async () => {
	const logs: string[] = [];
	const topic = ensureTopic("nosb", mkdtempSync(join(tmpdir(), "ar-ctl-")));
	await runController({
		topic,
		models: {} as ModelRuntime,
		usage: { read: async () => undefined, lastError: "x" } as unknown as UsageProbe,
		windows: 1,
		concurrency: 1,
		log: (l) => logs.push(l),
		focus: resolveFocus(topic, "some hypothesis"),
		run: async () => assert.fail("no agent should run"),
		sandboxCheck: () => "docker not running",
	});
	assert.ok(logs.some((l) => /focus mode needs python_run/.test(l)));
});

test("focus: a verdict citing unverified findings is sent back twice, with re-verification queued", async () => {
	let cited = "";
	const h = harness({
		step: 3,
		windows: 1,
		silentVerifiers: true,
		focus: (t) => {
			const f = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "c", evidence: "e", sources: ["p"], status: "unverified" });
			cited = f.id;
			return resolveFocus(t, "free-text hypothesis");
		},
		onOrchestrate: () => writeFileSync(h.focus!.state, `## Claim tree\nC1 holds (${cited})\n## Verdict\nholds`),
		tasksPerEpoch: () => 0,
	});
	await h.go();
	const orch = h.specs.filter((s) => s.name === "orchestrator");
	assert.ok(h.logs.some((l) => new RegExp(`verdict cites unverified ${cited}; re-verifying ${cited}`).test(l)), h.logs.join("\n"));
	assert.match(orch[1].prompt, /rests on findings that are still unverified/);
	assert.ok(listTasks(h.topic.tasks).some((t) => t.title === `Re-verify ${cited}` && t.focus === h.focus!.key));
	assert.equal(orch.length, 3, "sent back twice, then the run ends");
	assert.ok(h.logs.includes("warning: ended without a recorded verdict"), h.logs.join("\n"));
});

test("focus: a verdict not recorded with focus_verdict is sent back twice, then ends with a warning", async () => {
	const h = harness({
		step: 3,
		windows: 1,
		focus: (t) => resolveFocus(t, "free-text hypothesis"),
		onOrchestrate: () => writeFileSync(h.focus!.state, "## Claim tree\nC1 holds\n## Verdict\nholds"),
		tasksPerEpoch: () => 0,
	});
	await h.go();
	const orch = h.specs.filter((s) => s.name === "orchestrator");
	assert.equal(orch.length, 3);
	assert.match(orch[1].prompt, /focus_verdict did not record it[\s\S]*No research task has run/);
	assert.match(orch[2].prompt, /focus_verdict did not record it/);
	assert.equal(h.logs.filter((l) => /not recorded with focus_verdict; sending back/.test(l)).length, 2);
	assert.ok(h.logs.includes("warning: ended without a recorded verdict"), h.logs.join("\n"));
});

test("focus: a verdict before any research is refused and sent back with a no-research note", async () => {
	const h = harness({
		step: 3,
		windows: 1,
		focus: (t) => resolveFocus(t, "free-text hypothesis"),
		onOrchestrate: async (_e, spec) => {
			writeFileSync(h.focus!.state, "## Claim tree\nC1 holds\n## Verdict\nholds");
			const tool = spec.tools.find((t) => t.name === "focus_verdict")!;
			await assert.rejects(() => tool.execute("id", { outcome: "holds", summary: "s", sources: ["p"] } as never, undefined, undefined, {} as never));
		},
		tasksPerEpoch: () => 0,
	});
	await h.go();
	const orch = h.specs.filter((s) => s.name === "orchestrator");
	assert.match(orch[1].prompt, /No research task has run in this focus yet/);
});

test("focus: a rerun after the verdict is recorded never plans and drains open verify tasks", async () => {
	const h = harness({
		step: 3,
		windows: 1,
		focus: (t) => {
			const f = resolveFocus(t, "free-text hypothesis");
			const target = appendFinding(t.ledger, { author: `focus-${f.key}`, kind: "insight", claim: f.target, evidence: "e", sources: ["p"], status: "unverified" });
			appendVerification(t.verifications, { findingId: target.id, check: "adversarial", verdict: "fail", rationale: "r", sources: [], by: `focus-${f.key}` });
			const n = appendFinding(t.ledger, { author: `focus-${f.key}`, kind: "insight", claim: "narrowed", evidence: "e", sources: ["p"], status: "unverified" });
			createTask(t.tasks, `Re-verify ${n.id}`, n.claim, { type: "verify", findingId: n.id, focus: f.key });
			return f;
		},
	});
	await h.go();
	assert.ok(!h.calls.includes("orchestrator"), `calls: ${h.calls.join(",")}`);
	assert.ok(h.calls.some((c) => c.startsWith("ver-")));
	assert.ok(listTasks(h.topic.tasks).every((t) => t.status === "done"));
	assert.ok(h.logs.some((l) => /verdict already recorded; in-scope tasks drained; ending run/.test(l)));
});

test("focus: after focus_verdict with a narrowed claim, the narrowed verify task drains and the orchestrator is not called again", async () => {
	let refuter = "";
	const h = harness({
		step: 3,
		windows: 1,
		focus: (t) => {
			const target = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "big", evidence: "e", sources: ["p"], status: "unverified" });
			const r = appendFinding(t.ledger, { author: "a", kind: "insight", claim: "C2 fails", evidence: "e", sources: ["p"], status: "unverified" });
			for (const c of ["citation", "adversarial"] as const) appendVerification(t.verifications, { findingId: r.id, check: c, verdict: "pass", rationale: "", sources: [], by: "v" });
			refuter = r.id;
			return resolveFocus(t, target.id);
		},
		onOrchestrate: async (e, spec) => {
			if (e !== 1) return;
			writeFileSync(h.focus!.state, `## Claim tree\nC2 refuted (${refuter})\n## Verdict\nholds with limits`);
			const tool = spec.tools.find((t) => t.name === "focus_verdict")!;
			const p = { outcome: "holds_with_limits", summary: "s", narrowedClaim: "small", sources: ["p"], refutedBy: [refuter] };
			await tool.execute("id", p as never, undefined, undefined, {} as never);
		},
		tasksPerEpoch: (e) => (e === 0 ? 2 : 0),
	});
	await h.go();
	assert.equal(h.calls.filter((c) => c === "orchestrator").length, 2, `calls: ${h.calls.join(",")}`);
	const narrowed = listTasks(h.topic.tasks).find((t) => t.title.startsWith("Verify ") && t.focus === h.focus!.key);
	assert.equal(narrowed?.status, "done");
	assert.ok(h.calls.lastIndexOf("orchestrator") < h.calls.findLastIndex((c) => c.startsWith("ver-")), `calls: ${h.calls.join(",")}`);
});
