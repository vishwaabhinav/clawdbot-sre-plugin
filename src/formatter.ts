import type { Alert, SentryAlert } from "./types.js";

export function formatAlert(alert: Alert): string {
  switch (alert.type) {
    case "sentry": {
      let msg = `🚨 *SENTRY: ${alert.shortId}*\n`;
      msg += `*Error:* ${alert.title}\n`;
      msg += `*Function:* \`${alert.function}\`\n`;
      if (alert.errorType) msg += `*Type:* ${alert.errorType}\n`;
      msg += `*Count:* ${alert.count} events\n`;
      if (alert.stackTrace) {
        const truncatedTrace =
          alert.stackTrace.length > 500
            ? alert.stackTrace.slice(0, 500) + "..."
            : alert.stackTrace;
        msg += `\n\`\`\`\n${truncatedTrace}\n\`\`\`\n`;
      }
      msg += `\n→ [View in Sentry](${alert.link})`;
      return msg;
    }
    case "posthog": {
      const direction = alert.changePercent > 0 ? "📈" : "📉";
      return `${direction} *POSTHOG: ${alert.metric}*\nCurrent: ${alert.current}\n7-day avg: ${alert.baseline}\nChange: ${alert.changePercent > 0 ? "+" : ""}${alert.changePercent.toFixed(1)}%`;
    }
    case "cloudwatch": {
      return `⚠️ *CLOUDWATCH: ${alert.metric}*\nResource: \`${alert.resource}\`\nValue: ${alert.value}`;
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
      return `[CLOUDWATCH] ${alert.metric}: ${alert.value} on ${alert.resource}`;
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
