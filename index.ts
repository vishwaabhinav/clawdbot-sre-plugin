// @ts-ignore - Plugin SDK types resolved at runtime
type ClawdbotPluginApi = any;
import type { NomieSreConfig, Alert } from "./src/types.js";
import {
  loadState,
  silenceAlerts,
  unsilenceAlerts,
  isSilenced,
  shouldSendDailySummary,
  markSummarySent,
} from "./src/state.js";
import { formatStatusReport, formatAlertPlain } from "./src/formatter.js";
import {
  runPoll,
  startPoller,
  stopPoller,
  isPollerRunning,
  type PollerDependencies,
} from "./src/services/poller.js";
import { getDailySummary, type DailySummary } from "./src/pollers/posthog.js";

function formatDailySummary(summary: DailySummary): string {
  const changeEmoji = (change: number) => {
    if (change > 10) return "📈";
    if (change < -10) return "📉";
    return "➡️";
  };

  const formatChange = (change: number) => {
    const sign = change > 0 ? "+" : "";
    return `${sign}${change}%`;
  };

  let msg = `📊 *Nomie Daily Summary* (${summary.date})\n\n`;
  
  msg += `*Users & Traffic*\n`;
  msg += `${changeEmoji(summary.dauChange)} DAU: *${summary.dau}* (${formatChange(summary.dauChange)} vs 7d avg)\n`;
  msg += `${changeEmoji(summary.pageviewsChange)} Pageviews: *${summary.totalPageviews}* (${formatChange(summary.pageviewsChange)})\n\n`;
  
  msg += `*Key Events*\n`;
  for (const event of summary.events) {
    if (event.count > 0 || event.avg > 0) {
      const displayName = event.name.replace(/_/g, " ");
      msg += `${changeEmoji(event.change)} ${displayName}: *${event.count}* (${formatChange(event.change)})\n`;
    }
  }

  return msg;
}

const plugin = {
  id: "nomie-sre",
  name: "Nomie SRE",
  description:
    "SRE monitoring for Nomie - polls Sentry, PostHog, and CloudWatch",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      sentryAuthToken: { type: "string" as const, secret: true },
      sentryOrg: { type: "string" as const },
      sentryProject: { type: "string" as const },
      posthogApiKey: { type: "string" as const, secret: true },
      posthogProjectId: { type: "string" as const },
      awsRegion: { type: "string" as const, default: "us-east-1" },
      pollIntervalMinutes: { type: "number" as const, default: 5 },
      alertChannel: { type: "string" as const, default: "telegram" },
      alertChatId: { type: "string" as const },
      // Auto-fix options
      autoFix: { type: "boolean" as const, default: false },
      autoFixRepo: { type: "string" as const },
      autoFixModel: { type: "string" as const, default: "sonnet" },
      autoFixTimeoutSeconds: { type: "number" as const, default: 1800 },
    },
  },

  register(api: ClawdbotPluginApi) {
    // Plugin config is in api.pluginConfig, NOT api.config (which is the full clawdbot config)
    const cfg = api.pluginConfig || {};
    
    const getConfig = (): NomieSreConfig => {
      // Merge env vars with plugin config
      return {
        sentryAuthToken:
          cfg.sentryAuthToken || process.env.SENTRY_AUTH_TOKEN,
        sentryOrg: cfg.sentryOrg || process.env.SENTRY_ORG,
        sentryProject: cfg.sentryProject || process.env.SENTRY_PROJECT,
        posthogApiKey:
          cfg.posthogApiKey || process.env.POSTHOG_API_KEY,
        posthogProjectId:
          cfg.posthogProjectId || process.env.POSTHOG_PROJECT_ID,
        awsRegion: cfg.awsRegion || process.env.AWS_REGION || "us-east-1",
        pollIntervalMinutes: cfg.pollIntervalMinutes || 5,
        alertChannel: cfg.alertChannel || "telegram",
        alertChatId: cfg.alertChatId || process.env.TELEGRAM_CHAT_ID,
        // Auto-fix options
        autoFix: cfg.autoFix || false,
        autoFixRepo: cfg.autoFixRepo || "",
        autoFixModel: cfg.autoFixModel || "sonnet",
        autoFixTimeoutSeconds: cfg.autoFixTimeoutSeconds || 1800,
      };
    };

    const sendAlert = async (message: string): Promise<void> => {
      const config = getConfig();
      if (!config.alertChatId) return;
      
      if (config.alertChannel === "telegram") {
        // Get bot token from clawdbot config
        const clawdbotConfig = api.config;
        const botToken = clawdbotConfig?.channels?.telegram?.botToken;
        if (!botToken) {
          console.error("[nomie-sre] No Telegram bot token configured");
          return;
        }
        
        const axios = (await import("axios")).default;
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: config.alertChatId,
          text: message,
          parse_mode: "Markdown",
        });
      }
    };

    const log = (message: string) => {
      console.log(message);
    };

    const getDeps = (): PollerDependencies => ({
      config: getConfig(),
      sendAlert,
      log,
      formatSummary: formatDailySummary,
    });

    // Register tools
    api.registerTool({
      name: "nomie_sre_poll",
      description:
        "Manually trigger a poll of Sentry, PostHog, and CloudWatch for issues",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute(_toolCallId: string, _params: Record<string, unknown>) {
        const alerts = await runPoll(getDeps());
        const result = {
          success: true,
          alertCount: alerts.length,
          alerts: alerts.map(formatAlertPlain),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    api.registerTool({
      name: "nomie_sre_status",
      description: "Show current SRE monitoring status and last poll results",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      async execute(_toolCallId: string, _params: Record<string, unknown>) {
        const state = loadState();
        const config = getConfig();
        const result = {
          success: true,
          status: formatStatusReport(state, config),
          pollerRunning: isPollerRunning(),
          silenced: isSilenced(state),
          silencedUntil: state.silencedUntil,
          lastPollTime: state.lastPollTime,
          alertCount: state.lastAlerts.length,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    api.registerTool({
      name: "nomie_sre_silence",
      description: "Silence SRE alerts for a specified number of minutes",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "Number of minutes to silence alerts (0 to unsilence)",
          },
        },
        required: ["minutes"],
      },
      async execute(_toolCallId: string, params: { minutes?: number }) {
        const minutes = params.minutes ?? 0;
        let result;
        if (minutes <= 0) {
          const state = unsilenceAlerts();
          result = {
            success: true,
            message: "Alerts unsilenced",
            silencedUntil: null,
          };
        } else {
          const state = silenceAlerts(minutes);
          result = {
            success: true,
            message: `Alerts silenced for ${minutes} minutes`,
            silencedUntil: state.silencedUntil,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    api.registerTool({
      name: "nomie_sre_summary",
      description: "Get daily usage summary from PostHog (DAU, pageviews, key events)",
      parameters: {
        type: "object",
        properties: {
          send: {
            type: "boolean",
            description: "If true, also send the summary to the alert channel",
          },
        },
        required: [],
      },
      async execute(_toolCallId: string, params: { send?: boolean }) {
        const config = getConfig();
        if (!config.posthogApiKey || !config.posthogProjectId) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: "PostHog not configured" }) }],
            details: { success: false, error: "PostHog not configured" },
          };
        }

        const summary = await getDailySummary(config.posthogApiKey, config.posthogProjectId);
        if (!summary) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: "Failed to fetch summary" }) }],
            details: { success: false, error: "Failed to fetch summary" },
          };
        }

        const formatted = formatDailySummary(summary);
        
        if (params.send) {
          await sendAlert(formatted);
          markSummarySent();
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, summary, formatted }, null, 2) }],
          details: { success: true, summary },
        };
      },
    });

    // Register CLI commands - use single command with action argument
    // to avoid subcommand name conflicts with global commands
    api.registerCli(
      ({ program }: { program: any }) => {
        program
          .command("nomie-sre <action> [args...]")
          .description("Nomie SRE monitoring (actions: status, poll, alerts, silence, unsilence)")
          .action(async (action: string, args: string[]) => {
            switch (action) {
              case "status": {
                const state = loadState();
                const config = getConfig();
                console.log(formatStatusReport(state, config));
                console.log(`\nPoller: ${isPollerRunning() ? "running" : "stopped"}`);
                break;
              }
              case "poll": {
                console.log("Triggering manual poll...");
                const alerts = await runPoll(getDeps());
                console.log(`Poll complete. Found ${alerts.length} alerts.`);
                for (const alert of alerts) {
                  console.log(`  ${formatAlertPlain(alert)}`);
                }
                break;
              }
              case "alerts": {
                const state = loadState();
                if (state.lastAlerts.length === 0) {
                  console.log("No recent alerts");
                } else {
                  console.log(`Recent alerts (${state.lastAlerts.length}):`);
                  for (const alert of state.lastAlerts) {
                    console.log(`  ${formatAlertPlain(alert)}`);
                  }
                }
                break;
              }
              case "silence": {
                const minutes = parseInt(args[0] || "30", 10);
                if (minutes <= 0) {
                  unsilenceAlerts();
                  console.log("Alerts unsilenced");
                } else {
                  const state = silenceAlerts(minutes);
                  console.log(`Alerts silenced until ${state.silencedUntil}`);
                }
                break;
              }
              case "unsilence": {
                unsilenceAlerts();
                console.log("Alerts unsilenced");
                break;
              }
              case "summary": {
                const config = getConfig();
                if (!config.posthogApiKey || !config.posthogProjectId) {
                  console.log("PostHog not configured");
                  break;
                }
                console.log("Fetching daily summary...");
                const summary = await getDailySummary(config.posthogApiKey, config.posthogProjectId);
                if (summary) {
                  console.log(formatDailySummary(summary));
                  if (args[0] === "--send") {
                    await sendAlert(formatDailySummary(summary));
                    markSummarySent();
                    console.log("\nSummary sent to alert channel.");
                  }
                } else {
                  console.log("Failed to fetch summary");
                }
                break;
              }
              default:
                console.log("Usage: clawdbot nomie-sre <status|poll|alerts|silence [mins]|unsilence|summary [--send]>");
            }
          });
      },
      { commands: ["nomie-sre"] }
    );

    // Register background service
    api.registerService({
      id: "nomie-sre-poller",
      name: "nomie-sre-poller",
      start: async () => {
        startPoller(getDeps());
      },
      stop: async () => {
        stopPoller(log);
      },
    });
  },
};

export default plugin;
