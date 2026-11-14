import { test } from "node:test";
import assert from "node:assert/strict";
import { afterEpoch, MAX_SEND_BACKS, PLANNING, type Phase } from "../src/lifecycle.ts";

const o = { empty: false, interrupted: false, verdictInState: false, recorded: false };

test("afterEpoch: one row per rule", () => {
	const cases: [string, Phase, Partial<typeof o>, ReturnType<typeof afterEpoch>][] = [
		["recorded drains", PLANNING, { recorded: true, empty: true, verdictInState: true }, { phase: { kind: "draining", reason: "verdict recorded" } }],
		["unrecorded verdict is sent back", PLANNING, { empty: true, verdictInState: true }, { phase: { ...PLANNING, sentBack: 1 }, nudge: "verdict" }],
		[
			"send-back cap ends with a warning",
			{ ...PLANNING, sentBack: MAX_SEND_BACKS },
			{ empty: true, verdictInState: true },
			{ phase: { kind: "done", reason: "verdict never recorded" }, warning: "warning: ended without a recorded verdict" },
		],
		["empty epoch is nudged once", PLANNING, { empty: true }, { phase: { ...PLANNING, nudged: true }, nudge: "empty" }],
		["empty after a nudge ends", { ...PLANNING, nudged: true }, { empty: true }, { phase: { kind: "done", reason: "orchestrator created no tasks twice" } }],
		["tasks created: keep planning, nudge resets", { kind: "planning", nudged: true, sentBack: 1 }, {}, { phase: { kind: "planning", nudged: false, sentBack: 1 } }],
		["interrupted: keep planning", PLANNING, { interrupted: true, empty: true, verdictInState: true }, { phase: PLANNING }],
		["draining is terminal for planning", { kind: "draining", reason: "r" }, { empty: true }, { phase: { kind: "draining", reason: "r" } }],
	];
	for (const [name, p, x, want] of cases) assert.deepEqual(afterEpoch(p, { ...o, ...x }), want, name);
});
