import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { REPO_ROOT } from "./topic.ts";

// Agent-written Python runs in Docker: no network, capped memory/CPU/pids,
// read-only root, non-root user. Built from sandbox/Dockerfile.
export const SANDBOX_IMAGE = "auto-research-py:2";
const MAX_OUTPUT = 8000;

/** Build the image if it is missing. Returns an error message instead of throwing. */
export function ensureSandboxImage(): string | undefined {
	try {
		execFileSync("docker", ["image", "inspect", SANDBOX_IMAGE], { stdio: "ignore" });
		return undefined;
	} catch {
		// not built yet (or docker is down); try building
	}
	try {
		execFileSync("docker", ["build", "-q", "-t", SANDBOX_IMAGE, join(REPO_ROOT, "sandbox")], { stdio: "ignore" });
		return undefined;
	} catch (e) {
		return `sandbox unavailable (is Docker running?): ${String(e).slice(0, 200)}`;
	}
}

export interface PythonResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
}

const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[output truncated at ${MAX_OUTPUT} chars]` : s);

export function runPython(code: string, timeoutSec = 60): Promise<PythonResult> {
	const name = `ar-py-${randomUUID().slice(0, 8)}`;
	const args = [
		"run", "--rm", "-i", "--name", name,
		"--network", "none", "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
		"--read-only", "--tmpfs", "/tmp:size=256m", "--tmpfs", "/work:size=256m,uid=10001",
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL",
		SANDBOX_IMAGE, "python", "-",
	];
	return new Promise((resolve) => {
		let timedOut = false;
		const child = execFile("docker", args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			clearTimeout(timer);
			const exitCode = err ? ((err as { code?: number }).code ?? null) : 0;
			resolve({ exitCode: typeof exitCode === "number" ? exitCode : null, output: clip(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim()), timedOut });
		});
		const timer = setTimeout(() => {
			timedOut = true;
			execFile("docker", ["kill", name], () => {});
		}, timeoutSec * 1000);
		child.stdin?.end(code);
	});
}
