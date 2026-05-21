import type { Alert, SentryAlert, NomieSreConfig } from "../types.js";
import { pollSentry } from "../pollers/sentry.js";
import { pollPostHog, getDailySummary } from "../pollers/posthog.js";
import { pollCloudWatch } from "../pollers/cloudwatch.js";
import {
  loadState,
  saveState,
  isSilenced,
  addSeenSentryIssues,
  updateSentryCounts,
  getSentryCounts,
  updateLastAlerts,
  shouldSendDailySummary,
  markSummarySent,
  hasAlertedAnomaly,
  markAnomalyAlerted,
  addPendingDigestAlerts,
  getPendingDigestAlerts,
  clearPendingDigestAlerts,
  shouldSendDigest,
} from "../state.js";
import { formatAlert } from "../formatter.js";
import axios from "axios";

import { spawn as nodeSpawn, execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Auto-fix state
let autoFixRunning = false;

// Escape Telegram Markdown special characters
function escapeMd(text: string): string {
  if (!text) return text;
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

interface FixResult {
  status: "pr_created" | "failed";
  pr_number?: number;
  pr_url?: string;
  root_cause?: string;
  fix_summary?: string;
  files_changed?: string[];
  confidence?: string;
  error?: string;
}

function generateBranch(shortId: string): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `fix/sentry-${shortId}-${ts}`;
}

// Trip if the last 3 autofix runs all failed with byte-identical, non-empty stderr.
// Catches the May-4-style scenario where the agent itself is panicking deterministically
// and we'd otherwise burn 12 retries/hour against a broken binary.
function checkCircuitBreaker(): { trip: boolean; reason?: string } {
  const baseDir = join(process.env.HOME || "/home/clawdbot", ".clawdbot", "extensions", "nomie-sre", "data", "autofix-runs");
  let files: string[];
  try {
    files = readdirSync(baseDir)
      .filter((f) => f.endsWith(".stderr.log"))
      .sort()
      .reverse()
      .slice(0, 3);
  } catch {
    return { trip: false };
  }
  if (files.length < 3) return { trip: false };
  const contents: (string | null)[] = files.map((f) => {
    try { return readFileSync(join(baseDir, f), "utf8"); } catch { return null; }
  });
  if (contents.some((c) => c === null)) return { trip: false };
  const allNonEmpty = contents.every((c) => c !== null && c.trim().length > 0);
  if (!allNonEmpty) return { trip: false };
  const allIdentical = contents.every((c) => c === contents[0]);
  if (!allIdentical) return { trip: false };
  return {
    trip: true,
    reason: `Last 3 autofix runs failed with identical stderr: ${contents[0]!.trim().slice(0, 200)}`,
  };
}

function buildFixPrompt(alerts: SentryAlert[], branch: string): string {
  const errorDetails = alerts.map((a, i) => `ERROR ${i + 1}:
- Sentry ID: ${a.shortId}
- Title: ${a.title}
- Function: ${a.function}
- Type: ${a.errorType || "Error"}
- Count: ${a.count} occurrences
- File: ${a.filename || "unknown"}
- Link: ${a.link}
${a.stackTrace ? `\nSTACK TRACE:\n${a.stackTrace}` : ""}`).join("\n\n");

  return `You are investigating production errors in nomie-monorepo.

${errorDetails}

INSTRUCTIONS:
You are already checked out on a fresh branch (${branch}) cut from origin's default branch. Do NOT run "git checkout main", "git pull", or "git checkout -b" — that work is already done.
1. Read the relevant files to understand the error context
2. Identify the root cause of each error
3. Implement minimal fixes (fix only what is broken, do not refactor)
4. Add or update tests if appropriate
5. Commit with a message starting with "fix: "
6. Push the branch to origin
7. Create a PR using: gh pr create --title "fix: <brief description>" --body "Auto-fix for Sentry errors: ${alerts.map(a => a.shortId).join(", ")}"

IMPORTANT:
- Skip errors in node_modules/ or native code — just note them
- Fix only app code (src/, app/, components/, etc.)
- Keep changes minimal and focused

When completely done, output ONLY this JSON block:

\`\`\`json
{
  "status": "pr_created",
  "pr_number": <the PR number>,
  "pr_url": "<full PR URL>",
  "root_cause": "<1-2 sentence explanation>",
  "fix_summary": "<1-2 sentence description of what you fixed>",
  "files_changed": ["<file1>", "<file2>"],
  "confidence": "high" or "medium" or "low"
}
\`\`\`

If you cannot fix any of the issues:

\`\`\`json
{
  "status": "failed",
  "error": "<explanation>"
}
\`\`\``;
}

function parseFixOutput(output: string): FixResult {
  const jsonBlock = output.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1].trim()); } catch {}
  }
  const rawJson = output.match(/\{[^{}]*"status"[^{}]*\}/g);
  if (rawJson) {
    try { return JSON.parse(rawJson[rawJson.length - 1]); } catch {}
  }
  const prMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (prMatch) {
    return {
      status: "pr_created",
      pr_number: parseInt(prMatch[1], 10),
      pr_url: prMatch[0],
      root_cause: "See PR for details",
      fix_summary: "See PR for details",
      files_changed: [],
      confidence: "medium",
    };
  }
  return { status: "failed", error: "Could not parse Codex output" };
}

async function spawnAutoFix(
  alerts: Alert[],
  config: NomieSreConfig,
  sendAlert: (msg: string) => Promise<void>,
  log: (msg: string) => void
): Promise<void> {
  log(`[nomie-sre] spawnAutoFix invoked: autoFix=${config.autoFix}, alerts=${alerts.length}, autoFixRepo=${config.autoFixRepo || "(unset)"}`);
  if (!config.autoFix || alerts.length === 0) return;
  if (autoFixRunning) {
    log("[nomie-sre] Auto-fix already running, skipping");
    return;
  }
  if (!config.autoFixRepo) {
    log("[nomie-sre] autoFixRepo not configured, skipping auto-fix");
    return;
  }

  // Auto-fix should still attempt even if stackTrace is missing.
  // We only skip errors that clearly originate in node_modules.
  const sentryAlertsRaw = (alerts.filter(a => a.type === "sentry") as SentryAlert[]);
  log(`[nomie-sre] spawnAutoFix: raw sentry alerts=${sentryAlertsRaw.length} firstStackTrace=${JSON.stringify(sentryAlertsRaw[0]?.stackTrace?.slice(0, 120) || null)}`);

  // Skip only if the stack trace points to node_modules. We still try to fix if
  // node_modules appears later in the trace (it often does) as long as at least
  // one frame points to app code.
  const sentryAlerts = sentryAlertsRaw.filter(a => {
    if (!a.stackTrace) return true;
    const lines = a.stackTrace.split("\n").map(l => l.trim()).filter(Boolean);
    const hasAppFrame = lines.some(l => l.includes("/apps/") || l.includes("/src/"));
    if (hasAppFrame) return true;
    // Otherwise, only keep if it doesn't look like it's purely node_modules.
    return !a.stackTrace.includes("node_modules");
  });

  log(`[nomie-sre] spawnAutoFix: eligible sentry alerts=${sentryAlerts.length}`);

  if (sentryAlerts.length === 0) {
    log("[nomie-sre] spawnAutoFix: no eligible Sentry alerts after filtering, skipping");
    return;
  }

  // Circuit breaker: if the last 3 runs all failed identically, the agent is broken
  // (deterministic panic state). Stop spawning until someone investigates.
  const cb = checkCircuitBreaker();
  if (cb.trip) {
    log(`[nomie-sre] Auto-fix circuit breaker tripped: ${cb.reason}`);
    try {
      await sendAlert(`\ud83d\uded1 Auto-fix circuit breaker tripped \u2014 skipping new runs.\n\n${cb.reason}\n\nManual investigation needed; delete recent stderr logs in data/autofix-runs/ to re-arm.`);
    } catch (err) {
      log(`[nomie-sre] Failed to send circuit breaker alert: ${err}`);
    }
    return;
  }

  const branch = generateBranch(sentryAlerts[0].shortId);

  // Deterministic git prep \u2014 don't trust the agent to checkout main / branch correctly.
  // Refuse to touch a dirty tree rather than risk destroying uncommitted work.
  try {
    const git = (cmd: string): string =>
      execSync(cmd, { cwd: config.autoFixRepo, stdio: ["ignore", "pipe", "pipe"] }).toString();

    const dirty = git("git status --porcelain").trim();
    if (dirty) {
      log(`[nomie-sre] Auto-fix aborted: working tree dirty in ${config.autoFixRepo}`);
      try {
        await sendAlert(`\u26a0\ufe0f Auto-fix aborted: ${config.autoFixRepo} has uncommitted changes \u2014 refusing to auto-stash or reset.\n\`\`\`\n${dirty.slice(0, 500)}\n\`\`\``);
      } catch (err) {
        log(`[nomie-sre] Failed to send dirty-tree alert: ${err}`);
      }
      return;
    }

    const defaultBranch = git("git symbolic-ref --short refs/remotes/origin/HEAD")
      .trim()
      .replace(/^origin\//, "");

    git("git fetch origin --prune");
    git(`git checkout ${defaultBranch}`);
    // Safe: dirty check passed above, so there's nothing to lose.
    git(`git reset --hard origin/${defaultBranch}`);
    git(`git checkout -b ${branch}`);
    log(`[nomie-sre] Git prep ok: on branch ${branch} from origin/${defaultBranch}`);
  } catch (err: any) {
    log(`[nomie-sre] Git prep failed: ${err?.message || err}`);
    try {
      await sendAlert(`\u274c Auto-fix git prep failed: ${err?.message || err}`);
    } catch {}
    return;
  }

  const prompt = buildFixPrompt(sentryAlerts, branch);
  const timeout = config.autoFixTimeoutSeconds || 1800;
  const model = config.autoFixModel || "openai-codex";

  const tmpFile = join(tmpdir(), `nomie-sre-autofix-${Date.now()}.txt`);
  writeFileSync(tmpFile, prompt);

  autoFixRunning = true;
  log(`[nomie-sre] Spawning auto-fix for ${sentryAlerts.length} errors (branch: ${branch}, model: ${model}, timeout: ${timeout}s)`);

  try {
    await sendAlert(`\u2699\ufe0f Auto-fix started for ${sentryAlerts.length} Sentry error(s): ${sentryAlerts.map(a => a.shortId).join(", ")}\nBranch: \`${branch}\``);
  } catch (err) {
    log(`[nomie-sre] Failed to send auto-fix started alert: ${err}`);
  }

  const proc = nodeSpawn(
    "/usr/bin/acpx",
    ["--timeout", String(timeout), "--cwd", config.autoFixRepo, "codex", "exec", "-f", tmpFile],
    {
      cwd: config.autoFixRepo,
      env: { ...process.env, PATH: `/home/clawdbot/.local/bin:/home/clawdbot/.bun/bin:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
  proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

  proc.on("close", async (code: number | null) => {
    autoFixRunning = false;

    const runTs = new Date().toISOString().replace(/[:.]/g, "-");
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
    const runId = `autofix-${safeBranch}-${runTs}`;

    // Persist full output for post-mortem debugging.
    // This is intentionally NOT written to /tmp because /tmp can be cleared/rebooted.
    let outPath: string | null = null;
    let errPath: string | null = null;
    try {
      const baseDir = join(process.env.HOME || "/home/clawdbot", ".clawdbot", "extensions", "nomie-sre", "data", "autofix-runs");
      mkdirSync(baseDir, { recursive: true });
      outPath = join(baseDir, `${runId}.stdout.log`);
      errPath = join(baseDir, `${runId}.stderr.log`);
      writeFileSync(outPath, stdout || "", "utf8");
      writeFileSync(errPath, stderr || "", "utf8");
    } catch (e) {
      log(`[nomie-sre] Auto-fix: failed to persist stdout/stderr: ${String(e)}`);
    }

    try { unlinkSync(tmpFile); } catch {}

    log(`[nomie-sre] Auto-fix exited with code ${code} (runId=${runId}${errPath ? `, stderr=${errPath}` : ""})`);

    if (code !== 0 && code !== null) {
      // Keep the Telegram message short, but make journald searchable.
      const errTail = (stderr || stdout || "Unknown error").slice(-2000);
      log(`[nomie-sre] Auto-fix failed (runId=${runId}). stderr tail:\n${errTail}`);

      const shortErr = (stderr.slice(-500) || stdout.slice(-500) || "Unknown error");

      // Telegram should include the actionable error, but avoid huge dumps.
      // Telegram message limit is ~4096 chars; keep a safe buffer.
      const raw = (stderr || stdout || "Unknown error");
      const MAX_TELEGRAM_BLOCK = 3400;
      let fullErrForTelegram = raw;
      if (raw.length > MAX_TELEGRAM_BLOCK) {
        const head = raw.slice(0, 1400);
        const tail = raw.slice(-1400);
        fullErrForTelegram = `TRUNCATED (len=${raw.length})\n--- HEAD ---\n${head}\n\n--- TAIL ---\n${tail}`;
      }

      const refs = [
        errPath ? `stderr: ${errPath}` : null,
        outPath ? `stdout: ${outPath}` : null,
        `journalctl: journalctl --user -u clawdbot-gateway.service | rg "${runId}"`,
      ].filter(Boolean).join("\n");

      try {
        await sendAlert(`\u274c Auto-fix failed (exit ${code}):\n\n*Summary (tail):*\n\`\`\`\n${shortErr}\n\`\`\`\n\n*Full error:*\n\`\`\`\n${fullErrForTelegram}\n\`\`\`\n\n${refs}`);
      } catch (err) {
        log(`[nomie-sre] Failed to send auto-fix failure alert: ${err}`);
      }
      return;
    }

    const result = parseFixOutput(stdout);
    log(`[nomie-sre] Auto-fix result: ${JSON.stringify(result)}`);

    if (result.status === "pr_created" && result.pr_url) {
      try {
        const rootCause = escapeMd(result.root_cause || "See PR");
        const fixSummary = escapeMd(result.fix_summary || "See PR");
        const files = escapeMd((result.files_changed || []).join(", ") || "See PR");
        await sendAlert(`\u2705 Auto-fix PR created!\n\n*Root cause:* ${rootCause}\n*Fix:* ${fixSummary}\n*Confidence:* ${result.confidence || "unknown"}\n*Files:* ${files}\n\n[Review PR](${result.pr_url})`);
      } catch (err) {
        log(`[nomie-sre] Failed to send PR created alert: ${err}`);
      }
    } else {
      try {
        await sendAlert(`\u26a0\ufe0f Auto-fix could not create a PR:\n${result.error || "Unknown reason"}\n\nManual investigation needed.`);
      } catch (err) {
        log(`[nomie-sre] Failed to send PR failure alert: ${err}`);
      }
    }
  });

  proc.on("error", async (err: Error) => {
    autoFixRunning = false;
    try { unlinkSync(tmpFile); } catch {}
    log(`[nomie-sre] Auto-fix spawn error: ${err.message}`);
    try {
      await sendAlert(`\u274c Auto-fix spawn failed: ${err.message}`);
    } catch (alertErr) {
      log(`[nomie-sre] Failed to send spawn error alert: ${alertErr}`);
    }
  });
}


// Daily summary hour (9 AM UTC)
const SUMMARY_HOUR_UTC = 9;

export interface PollerDependencies {
  config: NomieSreConfig;
  sendAlert: (message: string) => Promise<void>;
  log: (message: string) => void;
  formatSummary?: (summary: any) => string;
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export async function runPoll(deps: PollerDependencies): Promise<Alert[]> {
  const { config, sendAlert, log } = deps;

  // Prevent concurrent polls
  if (isPolling) {
    log("[nomie-sre] Poll skipped - previous poll still running");
    return [];
  }
  isPolling = true;

  try {
    log(`[nomie-sre] Starting poll at ${new Date().toISOString()}`);

    const state = loadState();
    const allAlerts: Alert[] = [];
    let sentryAlertsThisPoll: SentryAlert[] = [];

    // Check if silenced
    if (isSilenced(state)) {
      log("[nomie-sre] Alerts are silenced, skipping notifications");
    }

    // Poll Sentry
    if (config.sentryAuthToken && config.sentryOrg && config.sentryProject) {
      log("[nomie-sre] Polling Sentry...");
      const seenCounts = getSentryCounts();
      const sentryAlerts = await pollSentry(
        config.sentryAuthToken,
        config.sentryOrg,
        config.sentryProject,
        state.seenSentryIssues,
        seenCounts
      );
      sentryAlertsThisPoll = sentryAlerts;
      allAlerts.push(...sentryAlerts);

      // Update counts immediately (used to decide re-alerts). We intentionally do NOT
      // mark issues as "seen" until we successfully send an alert/digest message.
      const newCounts: Record<string, number> = {};
      for (const alert of sentryAlerts) {
        newCounts[alert.issueId] = alert.count;
      }
      updateSentryCounts(newCounts);
      log(`[nomie-sre]   Found ${sentryAlerts.length} new/updated issues`);
    }

    // Poll PostHog
    if (config.posthogApiKey && config.posthogProjectId) {
      log("[nomie-sre] Polling PostHog...");
      const posthogAlerts = await pollPostHog(
        config.posthogApiKey,
        config.posthogProjectId
      );
      // Filter out already-alerted anomalies (only alert once per metric per day)
      const newPosthogAlerts = posthogAlerts.filter(
        (alert) => !hasAlertedAnomaly(alert.metric)
      );
      allAlerts.push(...newPosthogAlerts);
      log(`[nomie-sre]   Found ${posthogAlerts.length} anomalies, ${newPosthogAlerts.length} new`);
    }

    // Poll CloudWatch
    if (config.awsRegion) {
      log("[nomie-sre] Polling CloudWatch...");
      const cloudwatchAlerts = await pollCloudWatch(config.awsRegion);
      allAlerts.push(...cloudwatchAlerts);
      log(`[nomie-sre]   Found ${cloudwatchAlerts.length} issues`);
    }

    // Update state
    updateLastAlerts(allAlerts);

    // Send alerts if not silenced
    if (allAlerts.length > 0 && !isSilenced(state)) {
      const digestMode = config.digestIntervalHours && config.digestIntervalHours > 0;
      
      if (digestMode) {
        // Digest mode: batch alerts and send periodically
        addPendingDigestAlerts(allAlerts);
        log(`[nomie-sre] Added ${allAlerts.length} alerts to digest queue`);
        
        // Check if it's time to send digest
        if (shouldSendDigest(config.digestIntervalHours!)) {
          const pendingAlerts = getPendingDigestAlerts();
          if (pendingAlerts.length > 0) {
            log(`[nomie-sre] Sending digest with ${pendingAlerts.length} alerts...`);
            
            // Group alerts by type
            const sentryAlerts = pendingAlerts.filter(a => a.type === "sentry");
            const posthogAlerts = pendingAlerts.filter(a => a.type === "posthog");
            const cloudwatchAlerts = pendingAlerts.filter(a => a.type === "cloudwatch");
            
            // Build digest message
            let digestMsg = `📊 *SRE Digest Report*\n_${pendingAlerts.length} issue(s) in the last ${config.digestIntervalHours}h_\n\n`;
            
            if (sentryAlerts.length > 0) {
              digestMsg += `🔴 *Sentry Errors* (${sentryAlerts.length}):\n`;
              for (const alert of sentryAlerts) {
                digestMsg += formatAlert(alert) + "\n\n";
              }
            }
            
            if (posthogAlerts.length > 0) {
              digestMsg += `📈 *PostHog Anomalies* (${posthogAlerts.length}):\n`;
              for (const alert of posthogAlerts) {
                digestMsg += formatAlert(alert) + "\n\n";
              }
            }
            
            if (cloudwatchAlerts.length > 0) {
              digestMsg += `☁️ *CloudWatch Alerts* (${cloudwatchAlerts.length}):\n`;
              for (const alert of cloudwatchAlerts) {
                digestMsg += formatAlert(alert) + "\n\n";
              }
            }
            
            try {
              await sendAlert(digestMsg.trim());

              // Mark Sentry issues as "seen" only after we successfully send the digest.
              const sentryIssueIds = sentryAlerts.map(a => (a as any).issueId).filter(Boolean);
              if (sentryIssueIds.length > 0) addSeenSentryIssues(sentryIssueIds);

              clearPendingDigestAlerts();

              // Mark PostHog anomalies as alerted
              for (const alert of posthogAlerts) {
                if (alert.type === "posthog") {
                  markAnomalyAlerted(alert.metric);
                }
              }
            } catch (error) {
              log(`[nomie-sre] Failed to send digest: ${error}`);
            }
          }
        }
      } else {
        // Immediate mode: send alerts right away
        log(`[nomie-sre] Sending ${allAlerts.length} alerts immediately...`);
        for (const alert of allAlerts) {
          try {
            await sendAlert(formatAlert(alert));

            // Mark Sentry issues as "seen" only after we successfully send the alert.
            if (alert.type === "sentry") {
              addSeenSentryIssues([(alert as any).issueId]);
            }

            // Mark PostHog anomalies as alerted so we don't re-alert today
            if (alert.type === "posthog") {
              markAnomalyAlerted(alert.metric);
            }
            await new Promise((r) => setTimeout(r, 200)); // Rate limit
          } catch (error) {
            log(`[nomie-sre] Failed to send alert: ${error}`);
          }
        }
      }
    }

    log(`[nomie-sre] Poll complete. ${allAlerts.length} alerts found.`);

    // Trigger auto-fix for Sentry errors if enabled
    if (allAlerts.length > 0) {
      const sentryCount = allAlerts.filter(a => a.type === "sentry").length;
      log(`[nomie-sre] Auto-fix check: autoFix=${config.autoFix}, alerts=${allAlerts.length}, sentryAlerts=${sentryCount}`);
    }
    if (allAlerts.length > 0 && config.autoFix) {
      await spawnAutoFix(allAlerts, config, sendAlert, log);
    }

    // Check if we should send daily summary (at or after SUMMARY_HOUR_UTC)
    const currentHour = new Date().getUTCHours();
    if (
      currentHour >= SUMMARY_HOUR_UTC &&
      shouldSendDailySummary() &&
      config.posthogApiKey &&
      config.posthogProjectId &&
      deps.formatSummary
    ) {
      log("[nomie-sre] Sending daily summary...");
      try {
        const summary = await getDailySummary(
          config.posthogApiKey,
          config.posthogProjectId
        );
        if (summary) {
          const formatted = deps.formatSummary(summary);
          await sendAlert(formatted);
          markSummarySent();
          log("[nomie-sre] Daily summary sent!");
        }
      } catch (error) {
        log(`[nomie-sre] Failed to send daily summary: ${error}`);
      }
    }

    return allAlerts;
  } finally {
    isPolling = false;
  }
}

export function startPoller(deps: PollerDependencies): void {
  const intervalMs = (deps.config.pollIntervalMinutes || 5) * 60 * 1000;

  if (pollerInterval) {
    clearInterval(pollerInterval);
  }

  deps.log(
    `[nomie-sre] Starting background poller (interval: ${deps.config.pollIntervalMinutes || 5} minutes)`
  );

  // Run immediately on start
  runPoll(deps).catch((error) => {
    deps.log(`[nomie-sre] Initial poll error: ${error}`);
  });

  // Then run on interval
  pollerInterval = setInterval(() => {
    runPoll(deps).catch((error) => {
      deps.log(`[nomie-sre] Poll error: ${error}`);
    });
  }, intervalMs);
}

export function stopPoller(log: (message: string) => void): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    log("[nomie-sre] Background poller stopped");
  }
}

export function isPollerRunning(): boolean {
  return pollerInterval !== null;
}
