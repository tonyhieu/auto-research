// Tracks subscription utilization from response headers (exact, free) and the
// usage endpoint (fallback), and turns it into a run/wrap/stop decision.

/** 5h window: write the window summary at WRAP, stop starting agents at STOP. */
export const WRAP_5H = 90;
export const STOP_5H = 97;
/** Weekly cap is 80%: summarize and stop a little early, hard-abort agents at the cap. */
export const WEEKLY_WRAP = 77;
export const WEEKLY_STOP = 79;
export const WEEKLY_HARD = 80;

const PREFIX = "anthropic-ratelimit-unified-";

export interface BudgetSnapshot {
	/** 0-100 */
	fiveHour?: number;
	/** Epoch ms when the current 5h window resets. */
	fiveHourReset?: number;
	/** Max over reported weekly windows, 0-100. */
	weekly?: number;
	/** True once the provider rejected a request because a window is exhausted. */
	rejected: boolean;
	updatedAt: number;
}

export type BudgetState = "run" | "wrap" | "stop";

/** Endpoint reports resets with ms precision, headers in whole seconds; windows are hours apart. */
export function sameWindow(a: number | undefined, b: number | undefined): boolean {
	return a !== undefined && b !== undefined && Math.abs(a - b) < 5 * 60_000;
}

/** Parse unified rate-limit headers; utilization headers are fractions (0.08 = 8%). */
export function parseLimitHeaders(headers: Record<string, string>): Partial<BudgetSnapshot> {
	const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	const out: Partial<BudgetSnapshot> = {};
	const weekly: number[] = [];
	for (const [k, v] of Object.entries(h)) {
		const m = k.startsWith(PREFIX) ? /^(\w+)-utilization$/.exec(k.slice(PREFIX.length)) : null;
		if (!m || !Number.isFinite(Number(v))) continue;
		if (m[1] === "5h") out.fiveHour = Number(v) * 100;
		else if (m[1].startsWith("7d")) weekly.push(Number(v) * 100);
	}
	if (weekly.length) out.weekly = Math.max(...weekly);
	const reset = Number(h[`${PREFIX}5h-reset`]);
	if (Number.isFinite(reset) && reset > 0) out.fiveHourReset = reset * 1000;
	if ([h[`${PREFIX}status`], h[`${PREFIX}5h-status`]].includes("rejected")) out.rejected = true;
	return out;
}

export function budgetState(s: BudgetSnapshot): BudgetState {
	const five = s.fiveHour ?? 0;
	const week = s.weekly ?? 0;
	if (s.rejected || five >= STOP_5H || week >= WEEKLY_STOP) return "stop";
	if (five >= WRAP_5H || week >= WEEKLY_WRAP) return "wrap";
	return "run";
}

export class Budget {
	snap: BudgetSnapshot = { rejected: false, updatedAt: 0 };
	/** Highest 5h utilization seen per window (keyed by reset time), to report how much of each window was used. */
	private peaks: { reset: number; peak: number }[] = [];

	/** Peak 5h utilization observed for the window that resets at `reset`. */
	peakFor(reset: number | undefined): number | undefined {
		return this.peaks.find((x) => sameWindow(x.reset, reset))?.peak;
	}

	/** Merge a header-derived or endpoint-derived reading. A new 5h window clears `rejected`. */
	update(p: Partial<BudgetSnapshot>, now = Date.now()): void {
		const newWindow =
			p.fiveHourReset !== undefined &&
			this.snap.fiveHourReset !== undefined &&
			!sameWindow(p.fiveHourReset, this.snap.fiveHourReset);
		this.snap = {
			...this.snap,
			...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
			rejected: p.rejected ?? (newWindow ? false : this.snap.rejected),
			updatedAt: now,
		};
		const { fiveHour, fiveHourReset } = this.snap;
		if (fiveHour !== undefined && fiveHourReset !== undefined) {
			const w = this.peaks.find((x) => sameWindow(x.reset, fiveHourReset));
			if (w) w.peak = Math.max(w.peak, fiveHour);
			else this.peaks.push({ reset: fiveHourReset, peak: fiveHour });
		}
	}

	/** After sleeping past a reset, the old window's readings are invalid; weekly still carries over. */
	startNewWindow(): void {
		this.snap = { weekly: this.snap.weekly, rejected: false, updatedAt: Date.now() };
	}

	fromHeaders(headers: Record<string, string>): void {
		this.update(parseLimitHeaders(headers));
	}

	state(): BudgetState {
		return budgetState(this.snap);
	}

	weeklyHardCapHit(): boolean {
		return (this.snap.weekly ?? 0) >= WEEKLY_HARD;
	}

	describe(): string {
		const f = (n?: number) => (n === undefined ? "?" : `${n.toFixed(0)}%`);
		const reset = this.snap.fiveHourReset ? new Date(this.snap.fiveHourReset).toISOString().slice(11, 16) : "?";
		return `5h ${f(this.snap.fiveHour)} (resets ${reset}Z) wk ${f(this.snap.weekly)}${this.snap.rejected ? " REJECTED" : ""}`;
	}
}
