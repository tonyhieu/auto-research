import { test } from "node:test";
import assert from "node:assert/strict";
import { citedIds, parseReportName, regenerateNote } from "../src/reports.ts";

test("report names parse into window start, focus key, and window number", () => {
	assert.deepEqual(parseReportName("2026-11-17T2028-fx-1c96975f-w1.md"), { since: "2026-11-17T20:28", focusKey: "fx-1c96975f", window: 1 });
	assert.deepEqual(parseReportName("2026-11-08T0756-w2.md"), { since: "2026-11-08T07:56", window: 2 });
	assert.equal(parseReportName("2026-11-11T2225-fx-1ade0bc1-w1.html"), undefined);
	assert.equal(parseReportName("notes.md"), undefined);
});

test("cited ids are unique in first-seen order; the regenerate note names deleted ones", () => {
	assert.deepEqual(citedIds("f-0000000b then f-0000000a, f-0000000b and xf-0000000c"), ["f-0000000b", "f-0000000a"]);
	const note = regenerateNote("2026-11-09T04:00:00.000Z", ["f-0000000a", "f-0000000b"], ["f-0000000b"]);
	assert.match(note, /cited 2 findings; these are no longer in the ledger, so do not cite them: f-0000000b\./);
});
