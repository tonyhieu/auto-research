// Hard guardrails applied to the analyst's chosen action before it runs, so autonomy cannot
// grind one claim, launch a locked topic, or start a focus run with no sandbox.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action, DriverConfig, TopicRecord } from "./portfolio.ts";
import { pidAlive, type TopicPaths } from "./topic.ts";

/** A live run holds the topic's lock (another driver, the UI, or a manual run); a crashed run's stale lock does not count. */
export function lockExists(topic: TopicPaths): boolean {
	try {
		return pidAlive(Number(readFileSync(join(topic.dir, ".lock"), "utf8")));
	} catch {
		return false;
	}
}

let dockerChecked = 0;
let dockerOk = false;
/** Cached `docker info` probe; focus runs need the sandbox and abort without it. */
export function dockerUp(now: number = Date.now(), ttl = 300_000): boolean {
	if (dockerChecked && now - dockerChecked < ttl) return dockerOk;
	dockerChecked = now;
	try {
		execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
		dockerOk = true;
	} catch {
		dockerOk = false;
	}
	return dockerOk;
}

/** Clamp an action to the guardrails; returns the action to actually run and a note when it changed. */
export function enforce(action: Action, rec: TopicRecord, cfg: DriverConfig, opts: { locked?: boolean; docker?: boolean } = {}): { action: Action; note?: string } {
	if (opts.locked && (action.kind === "breadth" || action.kind === "focus"))
		return { action: { kind: "idle", minutes: cfg.idleMinutes, reason: `${rec.slug} is locked by another run` }, note: "locked" };
	if (action.kind === "focus" && rec.consecutiveFocus >= cfg.maxConsecutiveFocus)
		return { action: { kind: "breadth", windows: action.windows }, note: `focus cap ${cfg.maxConsecutiveFocus} reached; breadth instead` };
	if (action.kind === "focus" && opts.docker === false) return { action: { kind: "breadth", windows: action.windows }, note: "docker down; breadth instead" };
	// A run that launched no agents (usually an exhausted budget) is no evidence the topic is finished.
	if (action.kind === "retire" && rec.lastReason === "empty")
		return { action: { kind: "idle", minutes: cfg.idleMinutes, reason: "last run was empty; not retiring on it" }, note: "last run empty; retire refused" };
	return { action };
}
