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
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function spawnClaudeCode(
  error: ErrorContext,
  branch: string
): Promise<FixResult> {
  const prompt = buildFixPrompt(error, branch);

  console.log(`[Spawner] Starting Claude Code for ${error.shortId}...`);
  console.log(`[Spawner] Branch: ${branch}`);
  console.log(`[Spawner] Timeout: ${TIMEOUT_MS / 1000}s`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Use claude CLI (uses OAuth credentials from ~/.claude/.credentials.json)
    const proc = spawn("/home/clawdbot/.local/bin/claude", ["-p", prompt, "--dangerously-skip-permissions"], {
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
      // Stream output for debugging
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
        resolve({ status: "failed", error: "Claude Code timed out after 10 minutes" });
        return;
      }

      if (code !== 0 && code !== null) {
        console.log(`[Spawner] Claude Code exited with code ${code}`);
        resolve({ status: "failed", error: `Claude Code exited with code ${code}: ${stderr.slice(-500)}` });
        return;
      }

      // Parse JSON from output
      const result = parseClaudeOutput(stdout);
      console.log(`[Spawner] Parsed result:`, result);
      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      console.log(`[Spawner] Spawn error:`, err);
      resolve({ status: "failed", error: `Spawn error: ${err.message}` });
    });
  });
}

export async function spawnFeedbackFix(ctx: FeedbackContext): Promise<FeedbackResult> {
  const prompt = buildFeedbackPrompt(ctx);

  console.log(`[Spawner] Addressing feedback for PR #${ctx.prNumber}...`);
  console.log(`[Spawner] ${ctx.threads.length} unresolved comments`);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn("/home/clawdbot/.local/bin/claude", ["-p", prompt, "--dangerously-skip-permissions"], {
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
        resolve({ status: "failed", error: "Timed out after 10 minutes" });
        return;
      }

      if (code !== 0 && code !== null) {
        resolve({ status: "failed", error: `Exit code ${code}: ${stderr.slice(-500)}` });
        return;
      }

      const result = parseFeedbackOutput(stdout);
      console.log(`[Spawner] Parsed feedback result:`, result);
      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ status: "failed", error: err.message });
    });
  });
}

function parseFeedbackOutput(output: string): FeedbackResult {
  const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {}
  }
  return { status: "failed", error: "Could not parse output" };
}

function parseClaudeOutput(output: string): FixResult {
  // Try to find JSON in code block
  const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1].trim());
    } catch (e) {
      console.log(`[Spawner] Failed to parse JSON block: ${e}`);
    }
  }

  // Try to find raw JSON object
  const rawJsonMatch = output.match(/\{[\s\S]*"status"[\s\S]*\}/);
  if (rawJsonMatch) {
    try {
      // Find the last complete JSON object (in case there are multiple)
      const matches = output.match(/\{[^{}]*"status"[^{}]*\}/g);
      if (matches && matches.length > 0) {
        return JSON.parse(matches[matches.length - 1]);
      }
    } catch (e) {
      console.log(`[Spawner] Failed to parse raw JSON: ${e}`);
    }
  }

  // Check if a PR was created by looking for GitHub URL
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
