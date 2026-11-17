/** Schema-valid filler for ledger writes in tests (see schema/*.schema.json); tests override what they are about. */
export const PAPER = "0123456789abcdef0123456789abcdef01234567";
export const PAPERS = ["a", "b", "c", "d", "e"].map((c) => c.repeat(40));

export const VALID = {
	title: "Test finding title",
	evidence: "Evidence long enough to pass the schema minimum.",
	sources: [PAPER],
};

/** Rationale filler: the schema needs at least 40 chars. */
export const why = (s: string) => `${s} (test rationale padded to the schema minimum)`;
