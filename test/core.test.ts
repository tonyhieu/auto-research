import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsage } from "../src/usage.ts";
import { acquireLock, ensureTopic, slugify } from "../src/topic.ts";
import { appendFinding, createTask, listTasks, readFindings } from "../src/ledger.ts";

test("parseUsage prefers limits[] session entry", () => {
	const s = parseUsage({
		five_hour: { utilization: 1, resets_at: "2026-01-01T00:00:00Z" },
		limits: [{ kind: "session", percent: 42, resets_at: "2026-01-01T05:00:00Z" }],
	});
	assert.equal(s?.sessionPercent, 42);
	assert.equal(s?.sessionResetsAt.toISOString(), "2026-01-01T05:00:00.000Z");
});

test("parseUsage falls back to five_hour and rejects empty payloads", () => {
	assert.equal(parseUsage({ five_hour: { utilization: 7, resets_at: "2026-01-01T00:00:00Z" } })?.sessionPercent, 7);
	assert.equal(parseUsage({}), undefined);
});

test("topic layout, ledger, and tasks round-trip; malformed lines are skipped", () => {
	assert.equal(slugify("Generative Models: Diffusion!"), "generative-models-diffusion");
	const t = ensureTopic("Test Topic", mkdtempSync(join(tmpdir(), "ar-")));
	appendFinding(t.ledger, { author: "a", claim: "c", evidence: "e", sources: ["p1"], status: "unverified" });
	appendFileSync(t.ledger, '{"truncated": \n');
	assert.equal(readFindings(t.ledger).length, 1);
	createTask(t.tasks, "x", "y");
	assert.equal(listTasks(t.tasks)[0].status, "open");
});

test("acquireLock: fresh lock is taken, a live holder blocks, a stale one is replaced", () => {
	const dir = mkdtempSync(join(tmpdir(), "ar-"));
	const fresh = join(dir, "fresh.lock");
	assert.equal(acquireLock(fresh), true);
	assert.equal(readFileSync(fresh, "utf8"), String(process.pid));
	assert.equal(acquireLock(fresh), false); // held by this (live) process

	const stale = join(dir, "stale.lock");
	writeFileSync(stale, "999999999"); // no such pid
	assert.equal(acquireLock(stale), true);
	assert.equal(readFileSync(stale, "utf8"), String(process.pid));
});
