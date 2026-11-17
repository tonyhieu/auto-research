import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFindings } from "./ledger.ts";
import type { TopicPaths } from "./topic.ts";

export interface RunStart {
	pid: number;
	mode: "breadth" | "focus";
	focusKey?: string;
	target?: string;
	windows: number;
	concurrency: number;
	/** Log path relative to the topic dir. */
	log: string;
	origin: "cli" | "ui";
}

/** Append a start event to state/runs.jsonl; returns the run id for the matching end event. */
export function recordRunStart(topic: Pick<TopicPaths, "runs">, run: RunStart): string {
	const runId = `r-${randomUUID().slice(0, 8)}`;
	appendFileSync(topic.runs, JSON.stringify({ event: "start", runId, ts: new Date().toISOString(), ...run }) + "\n");
	return runId;
}

/** Sync, so it can run in the process exit handler. 0 = complete, 130 = signal, else error. */
export function recordRunEnd(topic: Pick<TopicPaths, "runs" | "ledger">, runId: string, exitCode: number): void {
	const reason = exitCode === 0 ? "complete" : exitCode === 130 ? "signal" : "error";
	const findings = readFindings(topic.ledger).length;
	appendFileSync(topic.runs, JSON.stringify({ event: "end", runId, ts: new Date().toISOString(), exitCode, reason, findings }) + "\n");
}
