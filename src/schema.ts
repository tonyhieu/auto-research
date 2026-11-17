import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { Finding, FindingKind, Verdict, Verification, VerificationCheck } from "./ledger.ts";
import { REPO_ROOT } from "./topic.ts";

/** JSON Schema exported from ui/arui/models.py (`uv run arui export-schema`); the only source of ledger write rules. */
type JsonSchema = TSchema & { properties: Record<string, TSchema & Record<string, unknown>> };
const load = (name: string): JsonSchema => JSON.parse(readFileSync(join(REPO_ROOT, "schema", `${name}.schema.json`), "utf8"));

const findingInput = load("finding-input");
const verdictInput = load("verdict-input");

export interface Experiment {
	setup: string;
	results: string;
}

/** ledger_add parameters. */
export interface FindingInput {
	kind: FindingKind;
	title: string;
	claim: string;
	evidence: string;
	experiment?: Experiment | null;
	sources: string[];
}

/** verify_record parameters. */
export interface VerdictInput {
	check: VerificationCheck;
	verdict: Verdict;
	rationale: string;
	sources?: string[];
}

/** Property schemas of FindingInput, so other tools reuse its limits (e.g. focus_verdict's narrowed claim). */
export const findingFields = findingInput.properties;
export const CLAIM_MAX = findingFields.claim.maxLength as number;
export const RATIONALE_MAX = verdictInput.properties.rationale.maxLength as number;

function validator(name: string) {
	const c = Compile(load(name));
	return (x: unknown, label: string) => {
		if (c.Check(x)) return;
		const errors = [...c.Errors(x)].map((e) => `${e.instancePath || "/"} ${e.message}`);
		throw new Error(`invalid ${label}: ${errors.join("; ")}`);
	};
}
const checkFinding = validator("finding");
const checkVerification = validator("verification");
const checkClaim = Compile(findingFields.claim);

export function assertFinding(x: unknown): asserts x is Finding {
	checkFinding(x, "finding");
}

export function assertVerification(x: unknown): asserts x is Verification {
	checkVerification(x, "verification");
}

/** Why `s` cannot be a finding's claim (empty if it can), e.g. for a free-text focus target. */
export const claimErrors = (s: string): string[] => [...checkClaim.Errors(s)].map((e) => e.message);

export const findingInputParams = Type.Unsafe<FindingInput>(findingInput);

/** VerdictInput with the check enum narrowed to the checks this verifier may record. */
export function verdictInputParams(checks: VerificationCheck[]) {
	const s = structuredClone(verdictInput);
	s.properties.check = { ...s.properties.check, enum: checks };
	return Type.Unsafe<VerdictInput>(s);
}
