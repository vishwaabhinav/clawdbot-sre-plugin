import { spawn } from "child_process";
import { buildFixPrompt, ErrorContext } from "./prompt.js";
import { buildFeedbackPrompt, FeedbackContext } from "./feedbackPrompt.js";

export interface FixResult {
  status: "pr_created" | "failed";
  pr_number?: number;
  pr_url?: string;
  root_cause?: string;
  fix_summary?: string;
  files_changed?: string[];
  tests_added?: boolean;
  confidence?: "high" | "medium" | "low";
  error?: string;
}

export interface FeedbackResult {
  status: "addressed" | "failed";
  changes?: Array<{ comment_id: number; summary: string }>;
  files_changed?: string[];
  error?: string;
}

const REPO_PATH = "/home/clawdbot/repos/nomie-monorepo";
const CLAUDE_PATH = "/home/clawdbot/.local/bin/claude";
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function runClaude<T>(prompt: string, parseOutput: (stdout: string) => T): Promise<T> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(CLAUDE_PATH, ["-p", prompt, "--dangerously-skip-permissions"], {
      cwd: REPO_PATH,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      console.log(`[Spawner] Timeout reached, killing process...`);
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, TIMEOUT_MS);

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      process.stdout.write(chunk);
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        resolve({ status: "failed", error: "Timed out after 10 minutes" } as T);
        return;
      }

      if (code !== 0 && code !== null) {
        console.log(`[Spawner] Claude Code exited with code ${code}`);
        resolve({ status: "failed", error: `Exit code ${code}: ${stderr.slice(-500)}` } as T);
        return;
      }

      const result = parseOutput(stdout);
      console.log(`[Spawner] Parsed result:`, result);
      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ status: "failed", error: err.message } as T);
    });
  });
}

export async function spawnClaudeCode(
  error: ErrorContext,
  branch: string
): Promise<FixResult> {
  console.log(`[Spawner] Starting Claude Code for ${error.shortId}...`);
  console.log(`[Spawner] Branch: ${branch}`);

  return runClaude(buildFixPrompt(error, branch), parseClaudeOutput);
}

export async function spawnFeedbackFix(ctx: FeedbackContext): Promise<FeedbackResult> {
  console.log(`[Spawner] Addressing feedback for PR #${ctx.prNumber}...`);
  console.log(`[Spawner] ${ctx.threads.length} unresolved comments`);

  return runClaude(buildFeedbackPrompt(ctx), parseFeedbackOutput);
}

function parseJsonBlock<T>(output: string): T | null {
  const jsonBlock = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1].trim()); } catch {}
  }
  const rawJson = output.match(/\{[^{}]*"status"[^{}]*\}/g);
  if (rawJson) {
    try { return JSON.parse(rawJson[rawJson.length - 1]); } catch {}
  }
  return null;
}

function parseFeedbackOutput(output: string): FeedbackResult {
  return parseJsonBlock<FeedbackResult>(output) || { status: "failed", error: "Could not parse output" };
}

function parseClaudeOutput(output: string): FixResult {
  const parsed = parseJsonBlock<FixResult>(output);
  if (parsed) return parsed;

  // Fallback: detect PR creation from GitHub URL
  const prUrlMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (prUrlMatch) {
    return {
      status: "pr_created",
      pr_number: parseInt(prUrlMatch[1], 10),
      pr_url: prUrlMatch[0],
      root_cause: "See PR for details",
      fix_summary: "See PR for details",
      files_changed: [],
      tests_added: false,
      confidence: "medium",
    };
  }

  return { status: "failed", error: "Could not parse Claude Code output" };
}

export function generateBranch(shortId: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return `fix/sentry-${shortId}-${timestamp}`;
}
