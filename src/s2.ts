// Semantic Scholar Graph API client. One process-wide limiter: the API 429s
// at ~1 req/s even with a key, and all agents share this process.
import { appendFileSync } from "node:fs";

const BASE = "https://api.semanticscholar.org/graph/v1";
const MIN_GAP_MS = 1100;
const MAX_RETRIES = 5;

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serialize all requests and keep MIN_GAP_MS between them. */
function schedule<T>(fn: () => Promise<T>): Promise<T> {
	const run = chain.then(async () => {
		const wait = lastCall + MIN_GAP_MS - Date.now();
		if (wait > 0) await sleep(wait);
		try {
			return await fn();
		} finally {
			lastCall = Date.now();
		}
	});
	chain = run.catch(() => undefined);
	return run;
}

async function get(path: string, params: Record<string, string | number>): Promise<unknown> {
	const key = process.env.S2_API_KEY;
	const url = `${BASE}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
	for (let attempt = 0; ; attempt++) {
		const res = await schedule(() =>
			fetch(url, { headers: key ? { "x-api-key": key } : {}, signal: AbortSignal.timeout(30_000) }),
		);
		if (res.ok) return res.json();
		if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
			await sleep(2000 * 2 ** attempt);
			continue;
		}
		throw new Error(`Semantic Scholar ${res.status}: ${(await res.text()).slice(0, 200)}`);
	}
}

export const PAPER_FIELDS = "paperId,title,year,venue,authors,abstract,citationCount,externalIds";

export interface Paper {
	paperId: string;
	title: string;
	year?: number;
	venue?: string;
	authors?: { name: string }[];
	abstract?: string | null;
	citationCount?: number;
	externalIds?: Record<string, string>;
}

let cachePath: string | undefined;
const cached = new Set<string>();

/** Append metadata of every paper seen to this file (one process per topic, so one writer). */
export function setPaperCache(path: string): void {
	cachePath = path;
	cached.clear();
}

function cachePapers(papers: Paper[]): void {
	if (!cachePath) return;
	for (const p of papers) {
		if (!p?.paperId || cached.has(p.paperId)) continue;
		cached.add(p.paperId);
		const authors = (p.authors ?? []).slice(0, 3).map((a) => a.name);
		appendFileSync(cachePath, JSON.stringify({ paperId: p.paperId, title: p.title, year: p.year, venue: p.venue, authors }) + "\n");
	}
}

export async function searchPapers(query: string, limit = 10, year?: string): Promise<Paper[]> {
	const params: Record<string, string | number> = { query, limit, fields: PAPER_FIELDS };
	if (year) params.year = year;
	const json = (await get("/paper/search", params)) as { data?: Paper[] };
	cachePapers(json.data ?? []);
	return json.data ?? [];
}

export async function getPaper(id: string): Promise<Paper> {
	const p = (await get(`/paper/${encodeURIComponent(id)}`, { fields: PAPER_FIELDS })) as Paper;
	cachePapers([p]);
	return p;
}

/** Compact, model-friendly rendering of a paper. */
export function formatPaper(p: Paper, abstractChars = 600): string {
	const authors = (p.authors ?? []).slice(0, 3).map((a) => a.name).join(", ");
	const arxiv = p.externalIds?.ArXiv ? ` arXiv:${p.externalIds.ArXiv}` : "";
	const abs = p.abstract ? `\n  ${p.abstract.slice(0, abstractChars)}${p.abstract.length > abstractChars ? "…" : ""}` : "";
	return `[${p.paperId}] ${p.title} (${p.year ?? "?"}, ${p.venue || "n/a"}; ${authors}; cites=${p.citationCount ?? "?"}${arxiv})${abs}`;
}
