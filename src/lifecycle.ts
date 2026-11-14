/** Run lifecycle: planning runs orchestrator epochs, draining only finishes open in-scope tasks. */
export type Phase =
	| { kind: "planning"; nudged: boolean; sentBack: number }
	| { kind: "draining"; reason: string }
	| { kind: "done"; reason: string };

/** Times an unrecorded focus verdict is sent back to the orchestrator before the run ends. */
export const MAX_SEND_BACKS = 2;

export const PLANNING: Extract<Phase, { kind: "planning" }> = { kind: "planning", nudged: false, sentBack: 0 };

export interface EpochOutcome {
	/** The epoch left no open in-scope tasks. */
	empty: boolean;
	interrupted: boolean;
	/** The focus state file has a ## Verdict section. */
	verdictInState: boolean;
	/** focus_verdict has recorded this focus's verdict in the ledger. */
	recorded: boolean;
}

/** Next phase after an orchestrator epoch; `nudge` says which note to send with the next epoch. */
export function afterEpoch(p: Phase, o: EpochOutcome): { phase: Phase; nudge?: "empty" | "verdict"; warning?: string } {
	if (p.kind !== "planning") return { phase: p };
	if (o.recorded) return { phase: { kind: "draining", reason: "verdict recorded" } };
	if (o.interrupted || !o.empty) return { phase: { ...p, nudged: false } };
	if (o.verdictInState) {
		if (p.sentBack < MAX_SEND_BACKS) return { phase: { ...p, nudged: false, sentBack: p.sentBack + 1 }, nudge: "verdict" };
		return { phase: { kind: "done", reason: "verdict never recorded" }, warning: "warning: ended without a recorded verdict" };
	}
	if (!p.nudged) return { phase: { ...p, nudged: true }, nudge: "empty" };
	return { phase: { kind: "done", reason: "orchestrator created no tasks twice" } };
}
