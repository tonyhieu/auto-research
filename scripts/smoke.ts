// Cheap end-to-end check: guard loads, custom tool round-trips, billing stays on the subscription.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAgent } from "../src/agent.ts";
import { ensureTopic } from "../src/topic.ts";
import { ledgerTools } from "../src/tools.ts";

const topic = ensureTopic("smoke", mkdtempSync(join(tmpdir(), "ar-smoke-")));
const models = await ModelRuntime.create();
const r = await runAgent({
	name: "smoke",
	cwd: topic.dir,
	systemPrompt: "You are a test agent. Follow instructions exactly.",
	prompt: "Call ledger_list once, then reply with exactly the tool's output text.",
	builtinTools: [],
	tools: Object.values(ledgerTools(topic, "smoke")),
	models,
	log: console.log,
});
console.log("reply:", JSON.stringify(r.text), "tools:", r.toolCalls, "tokens:", r.tokens.total);
