import { config as dotenvConfig } from "dotenv";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Load .env from skill directory (not cwd)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "..", ".env") });

import { pollSentry, SentryAlert } from "./pollers/sentry.js";
import { pollPostHog } from "./pollers/posthog.js";
import { pollCloudWatch } from "./pollers/cloudwatch.js";
import { loadState, saveState } from "./state.js";
import { findSimilarIssues, formatSuggestion } from "./memory.js";
import { getTask, createTask, updateTask, getStaleInvestigating, getAllOpenTasks } from "./state/tasks.js";
import { spawnClaudeCode, generateBranch, spawnFeedbackFix } from "./fixer/spawner.js";
import { sendPRNotification, sendFailureNotification, sendFeedbackNotification, sendMessage } from "./telegram/buttons.js";
import { pullLatest } from "./github/pr.js";
import { getUnresolvedThreads, replyToThread, getOpenBotPRs } from "./github/comments.js";
import { runDaemon } from "./daemon.js";

// Environment variables (loaded from .env above)
const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN || "";
const SENTRY_ORG = process.env.SENTRY_ORG || "";
const SENTRY_PROJECT = process.env.SENTRY_PROJECT || "";
const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || "";
const AUTO_FIX_ENABLED = process.env.AUTO_FIX_ENABLED !== "false";

// Rate limiting for feedback attempts
const FEEDBACK_ATTEMPTS_MAX = 3;
const feedbackAttempts: Map<number, { count: number; lastAttempt: Date }> = new Map();

// Lock to prevent concurrent polls (auto-fix can take >5min)
let isPolling = false;

type Alert =
  | SentryAlert
  | { type: "posthog"; metric: string; current: number; baseline: number; changePercent: number }
  | { type: "cloudwatch"; metric: string; resource: string; value: number; threshold: number };

function formatAlert(alert: Alert): string {
  switch (alert.type) {
    case "sentry": {
      let msg = `🚨 *SENTRY: ${alert.shortId}*\n`;
      msg += `*Error:* ${alert.title}\n`;
      msg += `*Function:* \`${alert.function}\`\n`;
      if (alert.errorType) msg += `*Type:* ${alert.errorType}\n`;
      msg += `*Count:* ${alert.count} events\n`;
      if (alert.stackTrace) {
        const truncatedTrace = alert.stackTrace.length > 500 ? alert.stackTrace.slice(0, 500) + "..." : alert.stackTrace;
        msg += `\n\`\`\`\n${truncatedTrace}\n\`\`\`\n`;
      }
      msg += `\n→ [View in Sentry](${alert.link})`;
      const similar = findSimilarIssues(alert.title, alert.function);
      msg += formatSuggestion(similar);
      return msg;
    }
    case "posthog": {
      const direction = alert.changePercent > 0 ? "📈" : "📉";
      return `${direction} *POSTHOG: ${alert.metric}*\nCurrent: ${alert.current}\n7-day avg: ${alert.baseline}\nChange: ${alert.changePercent > 0 ? "+" : ""}${alert.changePercent}%`;
    }
    case "cloudwatch": {
      return `⚠️ *CLOUDWATCH: ${alert.metric}*\nResource: \`${alert.resource}\`\nValue: ${alert.value}`;
    }
  }
}

async function attemptAutoFix(alert: SentryAlert): Promise<void> {
  console.log(`\n[AutoFix] Attempting fix for ${alert.shortId}...`);

  const existingTask = getTask(alert.issueId);
  if (existingTask) {
    if (["pr_open", "merged"].includes(existingTask.state)) {
      console.log(`[AutoFix] Skipping ${alert.shortId}: already ${existingTask.state}`);
      return;
    }
    if (existingTask.state === "investigating") {
      const staleTasks = getStaleInvestigating(15);
      if (!staleTasks.find(t => t.sentry_id === alert.issueId)) {
        console.log(`[AutoFix] Skipping ${alert.shortId}: currently being investigated`);
        return;
      }
      console.log(`[AutoFix] Resetting stale task for ${alert.shortId}`);
    }
  }

  const task = createTask(alert.issueId, alert.shortId, {
    title: alert.title,
    function: alert.function,
    count: alert.count,
    stackTrace: alert.stackTrace,
    link: alert.link,
  });
  console.log(`[AutoFix] Created task for ${alert.shortId} (attempt ${task.attempts})`);

  try {
    await pullLatest();
    const branch = generateBranch(alert.shortId);
    console.log(`[AutoFix] Branch: ${branch}`);

    const result = await spawnClaudeCode({
      sentryId: alert.issueId,
      shortId: alert.shortId,
      title: alert.title,
      function: alert.function,
      count: alert.count,
      stackTrace: alert.stackTrace || "No stack trace available",
      permalink: alert.link,
    }, branch);

    if (result.status === "pr_created" && result.pr_number) {
      updateTask(alert.issueId, {
        state: "pr_open",
        branch,
        pr_number: result.pr_number,
        pr_url: result.pr_url || null,
        root_cause: result.root_cause || null,
        fix_summary: result.fix_summary || null,
        files_changed: JSON.stringify(result.files_changed || []),
      });

      await sendPRNotification({
        shortId: alert.shortId,
        prNumber: result.pr_number,
        prUrl: result.pr_url || `https://github.com/tangentad/nomie/pull/${result.pr_number}`,
        errorTitle: alert.title,
        errorFunction: alert.function,
        errorCount: alert.count,
        rootCause: result.root_cause || "See PR for details",
        fixSummary: result.fix_summary || "See PR for details",
        filesChanged: result.files_changed || [],
        testsAdded: result.tests_added || false,
        confidence: result.confidence,
      });

      console.log(`[AutoFix] ✅ PR #${result.pr_number} created for ${alert.shortId}`);
    } else {
      updateTask(alert.issueId, { state: "failed" });
      await sendFailureNotification(alert.shortId, alert.title, result.error || "Unknown error", alert.link);
      console.log(`[AutoFix] ❌ Failed for ${alert.shortId}: ${result.error}`);
    }
  } catch (error: any) {
    console.error(`[AutoFix] Error processing ${alert.shortId}:`, error.message);
    updateTask(alert.issueId, { state: "failed" });
    await sendFailureNotification(alert.shortId, alert.title, error.message, alert.link);
  }
}

async function checkPRFeedback(): Promise<void> {
  console.log("\n[Feedback] Checking open PRs for review comments...");

  // Query GitHub directly for open bot PRs (no database dependency)
  const openPRs = await getOpenBotPRs();
  if (openPRs.length === 0) {
    console.log("[Feedback] No open PRs to check");
    return;
  }

  console.log(`[Feedback] Found ${openPRs.length} open PR(s)`);

  for (const pr of openPRs) {
    // Check rate limit
    const attempts = feedbackAttempts.get(pr.number);
    if (attempts && attempts.count >= FEEDBACK_ATTEMPTS_MAX) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if (attempts.lastAttempt > hourAgo) {
        console.log(`[Feedback] Skipping PR #${pr.number}: rate limited (${attempts.count}/${FEEDBACK_ATTEMPTS_MAX} attempts this hour)`);
        continue;
      }
      // Reset if more than an hour has passed
      feedbackAttempts.delete(pr.number);
    }

    // Get unresolved threads
    const threads = await getUnresolvedThreads(pr.number);
    if (threads.length === 0) {
      console.log(`[Feedback] PR #${pr.number}: no unresolved comments`);
      continue;
    }

    console.log(`[Feedback] PR #${pr.number}: ${threads.length} unresolved comments`);

    // Track attempt
    const current = feedbackAttempts.get(pr.number) || { count: 0, lastAttempt: new Date() };
    feedbackAttempts.set(pr.number, { count: current.count + 1, lastAttempt: new Date() });

    // Extract short ID from branch name (fix/sentry-NOMIE-MOBILE-6-...)
    const shortIdMatch = pr.branch.match(/fix\/sentry-([A-Z]+-[A-Z]+-\d+)/);
    const shortId = shortIdMatch ? shortIdMatch[1] : pr.branch;

    // Spawn Claude Code to address feedback
    const result = await spawnFeedbackFix({
      prNumber: pr.number,
      prTitle: pr.title,
      branch: pr.branch,
      threads,
    });

    if (result.status === "addressed" && result.changes) {
      // Reply to resolved threads
      for (const change of result.changes) {
        if (!change.summary.startsWith("SKIPPED")) {
          await replyToThread(
            pr.number,
            change.comment_id,
            `[Bot] Addressed: ${change.summary}`
          );
        }
      }

      // Send notification
      await sendFeedbackNotification(
        pr.number,
        shortId,
        pr.url,
        result.changes
      );

      console.log(`[Feedback] ✅ Addressed feedback on PR #${pr.number}`);
    } else {
      console.log(`[Feedback] ❌ Failed to address feedback: ${result.error}`);
    }
  }
}

async function poll(): Promise<void> {
  if (isPolling) {
    console.log(`[${new Date().toISOString()}] Poll skipped - previous poll still running`);
    return;
  }
  isPolling = true;

  try {
    console.log(`[${new Date().toISOString()}] Starting poll...`);
    console.log(`[Config] Auto-fix: ${AUTO_FIX_ENABLED ? "ENABLED" : "DISABLED"}`);

    const state = loadState();
    const allAlerts: Alert[] = [];

    // Poll Sentry
    if (SENTRY_AUTH_TOKEN && SENTRY_ORG && SENTRY_PROJECT) {
      console.log("Polling Sentry...");
      const sentryAlerts = await pollSentry(SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, state.seenSentryIssues);
      allAlerts.push(...sentryAlerts);
      state.seenSentryIssues = [...state.seenSentryIssues, ...sentryAlerts.map((a) => a.issueId)].slice(-1000);
      console.log(`  Found ${sentryAlerts.length} new issues`);
    }

    // Poll PostHog
    if (POSTHOG_API_KEY && POSTHOG_PROJECT_ID) {
      console.log("Polling PostHog...");
      const posthogAlerts = await pollPostHog(POSTHOG_API_KEY, POSTHOG_PROJECT_ID);
      allAlerts.push(...posthogAlerts);
      console.log(`  Found ${posthogAlerts.length} anomalies`);
    }

    // Poll CloudWatch
    console.log("Polling CloudWatch...");
    const cloudwatchAlerts = await pollCloudWatch();
    allAlerts.push(...cloudwatchAlerts);
    console.log(`  Found ${cloudwatchAlerts.length} issues`);

    // Send all alerts to Telegram
    for (const alert of allAlerts) {
      await sendMessage(formatAlert(alert));
      await new Promise((r) => setTimeout(r, 200));
    }

    // Auto-fix new Sentry alerts
    if (AUTO_FIX_ENABLED) {
      const sentryAlerts = allAlerts.filter((a): a is SentryAlert => a.type === "sentry");
      for (const alert of sentryAlerts) {
        await attemptAutoFix(alert);
        await new Promise((r) => setTimeout(r, 1000));
      }
      await checkPRFeedback();
    }

    if (allAlerts.length === 0) {
      console.log("No alerts to process");
    }

    state.lastPollTime = new Date().toISOString();
    saveState(state);
    console.log("\nPoll complete");
  } finally {
    isPolling = false;
  }
}

async function status(): Promise<void> {
  const state = loadState();
  const openTasks = getAllOpenTasks();

  console.log("Nomie SRE Status");
  console.log("================");
  console.log(`Last poll: ${state.lastPollTime}`);
  console.log(`Seen Sentry issues: ${state.seenSentryIssues.length}`);
  console.log("");
  console.log("Configuration:");
  console.log(`  Sentry: ${SENTRY_AUTH_TOKEN ? "✓" : "✗"}`);
  console.log(`  PostHog: ${POSTHOG_API_KEY ? "✓" : "✗"}`);
  console.log(`  CloudWatch: ${process.env.AWS_ACCESS_KEY_ID ? "✓" : "✗"}`);
  console.log(`  Telegram: ${process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? "✓" : "✗"}`);
  console.log(`  Auto-fix: ${AUTO_FIX_ENABLED ? "✓" : "✗"}`);
  console.log("");
  console.log("Open Tasks:");
  if (openTasks.length === 0) {
    console.log("  None");
  } else {
    for (const task of openTasks) {
      console.log(`  ${task.short_id}: ${task.state}${task.pr_number ? ` (PR #${task.pr_number})` : ""}`);
    }
  }
}

async function testAlert(): Promise<void> {
  console.log("Sending test alert...");
  await sendMessage(`🧪 *TEST ALERT*\nNomie SRE is working correctly!\n\nFeatures:\n✓ Rich error context\n✓ Auto-fix with Claude Code\n✓ PR feedback monitoring`);
  console.log("Test alert sent");
}

// CLI
const command = process.argv[2];
switch (command) {
  case "poll":
    poll().catch(console.error);
    break;
  case "status":
    status().catch(console.error);
    break;
  case "test":
    testAlert().catch(console.error);
    break;
  case "daemon":
    runDaemon().catch(console.error);
    break;
  default:
    console.log("Usage: nomie-sre <poll|status|test|daemon>");
    console.log("");
    console.log("Commands:");
    console.log("  poll    - Poll for errors and attempt auto-fixes");
    console.log("  status  - Show current status and open tasks");
    console.log("  test    - Send a test alert to Telegram");
    console.log("  daemon  - Start the Telegram callback handler");
}
