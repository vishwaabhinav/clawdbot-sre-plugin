import type { Alert, SentryAlert } from "./types.js";

// Escape characters that would otherwise be parsed by Telegram's classic Markdown
// (parse_mode: "Markdown"). Sentry/PostHog titles often contain `_` (e.g. USER_SPEAKING)
// which opens an italic span the parser can't close → "can't parse entities" 400.
function esc(text: string | undefined | null): string {
  if (!text) return "";
  return String(text).replace(/([_*`\[\]])/g, "\\$1");
}

// For content placed inside `inline code` or ```code blocks```, classic Markdown
// only requires that the literal backtick chars not appear (they'd close the span).
function escCode(text: string | undefined | null): string {
  if (!text) return "";
  return String(text).replace(/`/g, "'");
}

export function formatAlert(alert: Alert): string {
  switch (alert.type) {
    case "sentry": {
      // Show different header for re-alerts vs new issues
      let msg = alert.isReAlert
        ? `🔄 *SENTRY: ${esc(alert.shortId)}* (recurring)\n`
        : `🚨 *SENTRY: ${esc(alert.shortId)}*\n`;
      msg += `*Error:* ${esc(alert.title)}\n`;
      msg += `*Function:* \`${escCode(alert.function)}\`\n`;
      if (alert.errorType) msg += `*Type:* ${esc(alert.errorType)}\n`;
      if (alert.isReAlert && alert.newEvents) {
        msg += `*New events:* +${alert.newEvents} (total: ${alert.count})\n`;
      } else {
        msg += `*Count:* ${alert.count} events\n`;
      }
      if (alert.stackTrace) {
        const truncatedTrace =
          alert.stackTrace.length > 500
            ? alert.stackTrace.slice(0, 500) + "..."
            : alert.stackTrace;
        msg += `\n\`\`\`\n${escCode(truncatedTrace)}\n\`\`\`\n`;
      }
      msg += `\n→ [View in Sentry](${alert.link})`;
      return msg;
    }
    case "posthog": {
      const direction = alert.changePercent > 0 ? "📈" : "📉";
      return `${direction} *POSTHOG: ${esc(alert.metric)}*\nCurrent: ${alert.current}\n7-day avg: ${alert.baseline}\nChange: ${alert.changePercent > 0 ? "+" : ""}${alert.changePercent.toFixed(1)}%`;
    }
    case "cloudwatch": {
      let msg = `⚠️ *CLOUDWATCH: ${esc(alert.metric)}*\n`;
      msg += `*Resource:* \`${escCode(alert.resource)}\`\n`;
      if (alert.timestamp) {
        const time = new Date(alert.timestamp).toLocaleTimeString('en-US', { hour12: false });
        msg += `*Time:* ${time} UTC\n`;
      }
      if (alert.details) {
        // Truncate and format error details
        const details = alert.details.length > 300
          ? alert.details.slice(0, 300) + "..."
          : alert.details;
        msg += `\n\`\`\`\n${escCode(details)}\n\`\`\``;
      }
      return msg;
    }
  }
}

export function formatAlertPlain(alert: Alert): string {
  switch (alert.type) {
    case "sentry": {
      return `[SENTRY] ${alert.shortId}: ${alert.title} (${alert.count} events) - ${alert.function}`;
    }
    case "posthog": {
      const direction = alert.changePercent > 0 ? "UP" : "DOWN";
      return `[POSTHOG] ${alert.metric}: ${alert.current} (${direction} ${Math.abs(alert.changePercent).toFixed(1)}% from baseline ${alert.baseline})`;
    }
    case "cloudwatch": {
      let msg = `[CLOUDWATCH] ${alert.metric} on ${alert.resource}`;
      if (alert.details) {
        const shortDetails = alert.details.slice(0, 100).replace(/\n/g, ' ');
        msg += `: ${shortDetails}`;
      }
      return msg;
    }
  }
}

export function formatStatusReport(
  state: {
    lastPollTime: string;
    seenSentryIssues: string[];
    silencedUntil: string | null;
    lastAlerts: Alert[];
  },
  config: {
    sentryAuthToken?: string;
    posthogApiKey?: string;
    awsRegion?: string;
    alertChannel?: string;
  }
): string {
  const lines: string[] = [
    "Nomie SRE Status",
    "================",
    `Last poll: ${state.lastPollTime}`,
    `Seen Sentry issues: ${state.seenSentryIssues.length}`,
    "",
    "Configuration:",
    `  Sentry: ${config.sentryAuthToken ? "✓" : "✗"}`,
    `  PostHog: ${config.posthogApiKey ? "✓" : "✗"}`,
    `  CloudWatch: ${config.awsRegion ? "✓" : "✗"}`,
    `  Alert channel: ${config.alertChannel || "none"}`,
    "",
  ];

  if (state.silencedUntil) {
    const until = new Date(state.silencedUntil);
    if (until > new Date()) {
      lines.push(`⏸️  Alerts silenced until ${until.toLocaleString()}`);
      lines.push("");
    }
  }

  lines.push(`Last alerts (${state.lastAlerts.length}):`);
  if (state.lastAlerts.length === 0) {
    lines.push("  None");
  } else {
    for (const alert of state.lastAlerts.slice(0, 10)) {
      lines.push(`  ${formatAlertPlain(alert)}`);
    }
    if (state.lastAlerts.length > 10) {
      lines.push(`  ... and ${state.lastAlerts.length - 10} more`);
    }
  }

  return lines.join("\n");
}
