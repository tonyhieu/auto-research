import { FINDING_ID } from "./focus.ts";

/** Window report names written by the controller's summarize: `<YYYY-MM-DDTHHMM>[-<focus key>]-w<n>.md`. */
const REPORT_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(?:-(fx-[0-9a-f]{8}))?-w(\d+)\.md$/;

export interface ReportName {
	/** Window start as an ISO prefix (minute precision), the summary's `since`. */
	since: string;
	focusKey?: string;
	window: number;
}

export function parseReportName(name: string): ReportName | undefined {
	const m = REPORT_NAME.exec(name);
	if (!m) return undefined;
	return { since: `${m[1]}T${m[2]}:${m[3]}`, ...(m[4] ? { focusKey: m[4] } : {}), window: Number(m[5]) };
}

/** Finding ids cited in a report, in first-seen order. */
export function citedIds(text: string): string[] {
	return [...new Set(text.match(/\bf-[0-9a-f]{8}\b/g) ?? [])].filter((id) => FINDING_ID.test(id));
}

/** Appended to the summary prompt when an existing report is rewritten against the current ledger. */
export function regenerateNote(writtenAt: string, cited: string[], missing: string[]): string {
	return (
		`\n\nThis REGENERATES a report first written at ${writtenAt}. Since then findings may have been re-verified or deleted, ` +
		"so take every status and verdict from ledger_list/ledger_get now, not from the old report. " +
		`The old report cited ${cited.length} findings` +
		(missing.length ? `; these are no longer in the ledger, so do not cite them: ${missing.join(", ")}` : "") +
		"."
	);
}
