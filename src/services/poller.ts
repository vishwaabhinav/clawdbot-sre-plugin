import type { Alert, NomieSreConfig } from "../types.js";
import { pollSentry } from "../pollers/sentry.js";
import { pollPostHog, getDailySummary } from "../pollers/posthog.js";
import { pollCloudWatch } from "../pollers/cloudwatch.js";
import {
  loadState,
  saveState,
  isSilenced,
  addSeenSentryIssues,
  updateLastAlerts,
  shouldSendDailySummary,
  markSummarySent,
} from "../state.js";
import { formatAlert } from "../formatter.js";

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

    // Check if silenced
    if (isSilenced(state)) {
      log("[nomie-sre] Alerts are silenced, skipping notifications");
    }

    // Poll Sentry
    if (config.sentryAuthToken && config.sentryOrg && config.sentryProject) {
      log("[nomie-sre] Polling Sentry...");
      const sentryAlerts = await pollSentry(
        config.sentryAuthToken,
        config.sentryOrg,
        config.sentryProject,
        state.seenSentryIssues
      );
      allAlerts.push(...sentryAlerts);
      addSeenSentryIssues(sentryAlerts.map((a) => a.issueId));
      log(`[nomie-sre]   Found ${sentryAlerts.length} new issues`);
    }

    // Poll PostHog
    if (config.posthogApiKey && config.posthogProjectId) {
      log("[nomie-sre] Polling PostHog...");
      const posthogAlerts = await pollPostHog(
        config.posthogApiKey,
        config.posthogProjectId
      );
      allAlerts.push(...posthogAlerts);
      log(`[nomie-sre]   Found ${posthogAlerts.length} anomalies`);
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
      log(`[nomie-sre] Sending ${allAlerts.length} alerts...`);
      for (const alert of allAlerts) {
        try {
          await sendAlert(formatAlert(alert));
          await new Promise((r) => setTimeout(r, 200)); // Rate limit
        } catch (error) {
          log(`[nomie-sre] Failed to send alert: ${error}`);
        }
      }
    }

    log(`[nomie-sre] Poll complete. ${allAlerts.length} alerts found.`);

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
