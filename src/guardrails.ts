// Hard guardrails applied to the analyst's chosen action before it runs, so autonomy cannot
// grind one claim, launch a locked topic, or start a focus run with no sandbox.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Action, DriverConfig, TopicRecord } from "./portfolio.ts";
import type { TopicPaths } from "./topic.ts";

/** A run already holds the topic's lock (another driver, the UI, or a manual run). */
export const lockExists = (topic: TopicPaths): boolean => existsSync(join(topic.dir, ".lock"));

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
	return { action };
}
