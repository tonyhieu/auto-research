import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Same endpoint the pi-claude-subscription-connector footer reads.
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface UsageSnapshot {
	/** Five-hour window utilization, 0-100. */
	sessionPercent: number;
	sessionResetsAt: Date;
	/** Weekly all-models utilization when reported. */
	weeklyPercent?: number;
	fetchedAt: Date;
}

interface UsageJson {
	five_hour?: { utilization?: number; resets_at?: string } | null;
	seven_day?: { utilization?: number } | null;
	limits?: { kind?: string; group?: string; percent?: number; resets_at?: string; is_active?: boolean }[];
}

export function parseUsage(json: UsageJson, now = new Date()): UsageSnapshot | undefined {
	const session = json.limits?.find((l) => l.kind === "session");
	// Active weekly limits only; inactive scoped ones (e.g. Cowork) don't apply to us.
	const weekly = [
		...(json.limits ?? []).filter((l) => l.group === "weekly" && l.is_active !== false).map((l) => l.percent),
		json.seven_day?.utilization,
	].filter((n): n is number => typeof n === "number");
	const pct = session?.percent ?? json.five_hour?.utilization;
	const resets = session?.resets_at ?? json.five_hour?.resets_at;
	if (typeof pct !== "number" || !resets) return undefined;
	return {
		sessionPercent: pct,
		sessionResetsAt: new Date(resets),
		weeklyPercent: weekly.length ? Math.max(...weekly) : undefined,
		fetchedAt: now,
	};
}

/** Unrecoverable: needs a human to log in again. */
export class UsageAuthError extends Error {}

export class UsageProbe {
	private last?: UsageSnapshot;
	/** Why the most recent read attempt failed, for logging. */
	lastError?: string;

	constructor(
		private readonly models: ModelRuntime,
		private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
	) {}

	/** Fetch current usage; on 429/network errors, retry with backoff, then fall back to the last snapshot. */
	async read(retries = 3): Promise<UsageSnapshot | undefined> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				// getAuth refreshes the OAuth token when needed.
				const token = (await this.models.getAuth("anthropic"))?.auth.apiKey;
				if (!token) throw new UsageAuthError("no anthropic OAuth token; run `pi` and /login");
				const res = await fetch(USAGE_URL, {
					headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					const snap = parseUsage((await res.json()) as UsageJson);
					if (snap) {
						this.lastError = undefined;
						return (this.last = snap);
					}
					this.lastError = "unrecognized usage payload";
				} else if (res.status === 401 || res.status === 403) {
					throw new UsageAuthError(`usage endpoint auth failed (${res.status})`);
				} else {
					this.lastError = `HTTP ${res.status}`;
				}
			} catch (e) {
				if (e instanceof UsageAuthError) throw e;
				this.lastError = String(e);
			}
			// No backoff after the last attempt: nothing reads after it.
			if (attempt < retries) await this.sleep(5000 * 2 ** attempt);
		}
		return this.last;
	}
}
