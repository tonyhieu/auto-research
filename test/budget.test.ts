import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, budgetState, parseLimitHeaders, sameWindow } from "../src/budget.ts";
import { claimNextTask, createTask, listTasks, releaseTask, resetStaleClaims } from "../src/ledger.ts";
import { parseUsage } from "../src/usage.ts";
import { ensureTopic } from "../src/topic.ts";

// Captured from a real subscription response.
const REAL = {
	"anthropic-ratelimit-unified-5h-reset": "1794130800",
	"anthropic-ratelimit-unified-5h-status": "allowed",
	"anthropic-ratelimit-unified-5h-utilization": "0.08",
	"anthropic-ratelimit-unified-status": "allowed",
};

test("parses real 5h headers (fraction -> percent, epoch s -> ms)", () => {
	const p = parseLimitHeaders(REAL);
	assert.equal(p.fiveHour, 8);
	assert.equal(p.fiveHourReset, 1794130800_000);
	assert.equal(p.weekly, undefined);
	assert.equal(p.rejected, undefined);
});

test("weekly headers take the max; rejected status is detected", () => {
	const p = parseLimitHeaders({
		...REAL,
		"anthropic-ratelimit-unified-7d-utilization": "0.5",
		"anthropic-ratelimit-unified-7d_opus-utilization": "0.78",
		"anthropic-ratelimit-unified-5h-status": "rejected",
	});
	assert.equal(p.weekly, 78);
	assert.equal(p.rejected, true);
});

test("budget thresholds: 5h wrap/stop and weekly 80% cap", () => {
	const s = (fiveHour: number, weekly?: number, rejected = false) => budgetState({ fiveHour, weekly, rejected, updatedAt: 0 });
	assert.equal(s(50), "run");
	assert.equal(s(90), "wrap");
	assert.equal(s(97), "stop");
	assert.equal(s(10, 77), "wrap");
	assert.equal(s(10, 79), "stop");
	assert.equal(s(10, undefined, true), "stop");
	const b = new Budget();
	b.update({ weekly: 80 });
	assert.equal(b.weeklyHardCapHit(), true);
});

test("a new 5h reset time clears the rejected flag", () => {
	const b = new Budget();
	b.fromHeaders({ ...REAL, "anthropic-ratelimit-unified-5h-status": "rejected" });
	assert.equal(b.state(), "stop");
	b.fromHeaders({ ...REAL, "anthropic-ratelimit-unified-5h-reset": "1794148800", "anthropic-ratelimit-unified-5h-utilization": "0.01" });
	assert.equal(b.state(), "run");
});

test("endpoint ms-precision reset and header whole-second reset are the same window", () => {
	const b = new Budget();
	b.update({ fiveHourReset: Date.parse("2026-11-08T09:40:00.986Z"), rejected: true });
	b.fromHeaders(REAL); // 1794130800 = 09:40:00Z
	assert.equal(b.snap.rejected, true, "same window keeps rejected");
	assert.equal(sameWindow(Date.parse("2026-11-08T09:40:00.986Z"), 1794130800_000), true);
	assert.equal(sameWindow(1794130800_000, 1794130800_000 + 5 * 3600_000), false);
});

test("usage endpoint weekly ignores inactive scoped limits", () => {
	const s = parseUsage({
		limits: [
			{ kind: "session", percent: 5, resets_at: "2026-01-01T00:00:00Z" },
			{ kind: "weekly_scoped", group: "weekly", percent: 90, is_active: false },
			{ kind: "weekly_all", group: "weekly", percent: 40 },
		],
	});
	assert.equal(s?.weeklyPercent, 40);
});

test("claim, release with note, and stale-claim reset", () => {
	const t = ensureTopic("claims", mkdtempSync(join(tmpdir(), "ar-")));
	createTask(t.tasks, "a", "x");
	const c1 = claimNextTask(t.tasks, "sub-1");
	assert.equal(c1?.status, "claimed");
	assert.equal(claimNextTask(t.tasks, "sub-2"), undefined, "no double claim");
	releaseTask(t.tasks, c1!, "interrupted");
	const c2 = claimNextTask(t.tasks, "sub-2");
	assert.deepEqual(c2?.notes, ["interrupted"]);
	assert.equal(c2?.retries, undefined, "budget interruptions do not count as retries");
	releaseTask(t.tasks, c2!, "failed", { retry: true });
	assert.equal(claimNextTask(t.tasks, "sub-3")?.retries, 1);
	assert.equal(resetStaleClaims(t.tasks), 1);
	assert.deepEqual([listTasks(t.tasks)[0].status, listTasks(t.tasks)[0].retries], ["open", 1]);
});
