import { join, relative, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// The only extension research agents load: keeps OAuth requests billed to the
// Claude subscription. Everything else (memory.ts, pi-lens, ...) stays off.
export const SUBSCRIPTION_GUARD = join(
	getAgentDir(),
	"npm/node_modules/pi-claude-subscription-connector/extensions/subscription-guard.ts",
);
const OVERAGE_HEADER = "anthropic-ratelimit-unified-overage-in-use";

export class OverageError extends Error {}

/** Default model for research agents; override with RESEARCH_MODEL=<anthropic model id>. */
const MODEL_ID = process.env.RESEARCH_MODEL ?? "claude-opus-5-5";
/** Verifiers run cheaper; override with RESEARCH_VERIFIER_MODEL. */
export const VERIFIER_MODEL = process.env.RESEARCH_VERIFIER_MODEL ?? "claude-sonnet-5-5";
const THINKING = "medium" as const;

export interface AgentSpec {
	name: string;
	/** Working directory; write/edit are confined to it. */
	cwd: string;
	systemPrompt: string;
	prompt: string;
	builtinTools: string[];
	tools: ToolDefinition[];
	models: ModelRuntime;
	log?: (line: string) => void;
	/** Receives every provider response (rate-limit headers feed the budget). */
	onResponse?: (status: number, headers: Record<string, string>) => void;
	/** Return a reason to stop the agent after the current response (e.g. window exhausted). */
	shouldStop?: () => string | undefined;
	signal?: AbortSignal;
	/** Anthropic model id; defaults to MODEL_ID. */
	model?: string;
}

export interface AgentResult {
	text: string;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	toolCalls: number;
	/** Set when the agent was stopped before finishing; its ledger writes still persist. */
	interrupted?: string;
}

const inside = (root: string, p: string) => {
	const rel = relative(root, resolve(root, p.replace(/^~(?=\/|$)/, homedir())));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export async function runAgent(spec: AgentSpec): Promise<AgentResult> {
	const log = spec.log ?? (() => {});
	let overage = false;
	let interrupted: string | undefined;
	// Set after session creation; extension handlers run only once prompting starts.
	let stopSession: () => void = () => {};
	const stop = (reason: string) => {
		if (interrupted) return;
		interrupted = reason;
		log(`[${spec.name}] stopping: ${reason}`);
		stopSession();
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: getAgentDir(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		additionalExtensionPaths: [SUBSCRIPTION_GUARD],
		systemPrompt: spec.systemPrompt,
		extensionFactories: [
			(pi) => {
				// Registered via an extension (not customTools) so the guard aliases
				// them the same way it does for interactive pi extension tools.
				for (const t of spec.tools) pi.registerTool(t);
				pi.on("tool_call", (ev) => {
					if (ev.toolName !== "write" && ev.toolName !== "edit") return undefined;
					const path = String((ev.input as { path?: unknown }).path ?? "");
					if (inside(spec.cwd, path)) return undefined;
					return { block: true, reason: `Writes are restricted to ${spec.cwd}` };
				});
				pi.on("after_provider_response", (ev) => {
					if (ev.headers[OVERAGE_HEADER] === "true") overage = true;
					spec.onResponse?.(ev.status, ev.headers);
					// Checked here, before pi's auto-retry, so an exhausted window ends the agent
					// instead of burning retries; transient 429s still go through pi's retry.
					const reason = overage ? "overage" : spec.shouldStop?.();
					if (reason) stop(reason);
				});
			},
		],
	});
	await resourceLoader.reload();
	const { errors: loadErrors, extensions } = resourceLoader.getExtensions();
	if (loadErrors.length) throw new Error(`extension load failed: ${JSON.stringify(loadErrors)}`);
	if (!extensions.some((e) => e.path === SUBSCRIPTION_GUARD)) throw new Error("subscription guard not loaded");

	const modelId = spec.model ?? MODEL_ID;
	const model = spec.models.getModel("anthropic", modelId);
	if (!model) throw new Error(`unknown model anthropic/${modelId}`);
	const { session } = await createAgentSession({
		cwd: spec.cwd,
		model,
		thinkingLevel: THINKING,
		modelRuntime: spec.models,
		resourceLoader,
		sessionManager: SessionManager.inMemory(spec.cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3 } }),
		tools: [...spec.builtinTools, ...spec.tools.map((t) => t.name)],
	});

	stopSession = () => void session.abort();
	const onAbort = () => stop("aborted by controller");
	if (spec.signal?.aborted) onAbort();
	spec.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		await session.bindExtensions({});
		log(`[${spec.name}] start model=${session.model?.provider}/${session.model?.id} tools=${session.getActiveToolNames().join(",")}`);
		session.subscribe((ev) => {
			if (ev.type === "tool_execution_start") log(`[${spec.name}] tool ${ev.toolName}`);
		});
		if (!interrupted) await session.prompt(spec.prompt);
		if (overage) throw new OverageError(`${spec.name}: request billed to extra usage; aborting`);
		const s = session.getSessionStats();
		return {
			text: session.getLastAssistantText() ?? "",
			tokens: { input: s.tokens.input, output: s.tokens.output, cacheRead: s.tokens.cacheRead, cacheWrite: s.tokens.cacheWrite, total: s.tokens.total },
			toolCalls: s.toolCalls,
			interrupted,
		};
	} finally {
		spec.signal?.removeEventListener("abort", onAbort);
		session.dispose();
	}
}
