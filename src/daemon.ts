import axios from "axios";
import { getTaskByPR, updateTask } from "./state/tasks.js";
import { mergePR, closePR, getPRDiff } from "./github/pr.js";
import { sendActionConfirmation, sendDiff, answerCallback } from "./telegram/buttons.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const POLL_INTERVAL = 3000; // 3 seconds

let lastUpdateId = 0;

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    from: { username?: string; first_name?: string };
    message?: { message_id: number };
  };
}

async function pollUpdates(): Promise<TelegramUpdate[]> {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
      {
        params: {
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ["callback_query"],
        },
        timeout: 35000,
      }
    );
    return response.data.result || [];
  } catch (error: any) {
    if (error.code !== "ECONNABORTED") {
      console.error("[Daemon] Error polling Telegram:", error.message);
    }
    return [];
  }
}

async function handleCallback(query: TelegramUpdate["callback_query"]): Promise<void> {
  if (!query || !query.data) return;

  const [action, prNumberStr] = query.data.split(":");
  const prNumber = parseInt(prNumberStr, 10);

  if (isNaN(prNumber)) {
    await answerCallback(query.id, "Invalid PR number");
    return;
  }

  const user = query.from.username || query.from.first_name || "Unknown";
  console.log(`[Daemon] Received ${action} for PR #${prNumber} from ${user}`);

  const task = getTaskByPR(prNumber);
  if (!task) {
    console.log(`[Daemon] No task found for PR #${prNumber}`);
    await answerCallback(query.id, "Task not found in database");
    return;
  }

  switch (action) {
    case "approve": {
      await answerCallback(query.id, "Merging PR...");

      const result = await mergePR(prNumber);
      if (result.success) {
        updateTask(task.sentry_id, { state: "merged" });
        await sendActionConfirmation("merged", prNumber, task.short_id);
        console.log(`[Daemon] PR #${prNumber} merged successfully`);
      } else {
        console.error(`[Daemon] Failed to merge PR #${prNumber}:`, result.error);
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: CHAT_ID,
          text: `❌ Failed to merge PR #${prNumber}: ${result.error}`,
        });
      }
      break;
    }

    case "reject": {
      await answerCallback(query.id, "Closing PR...");

      const result = await closePR(prNumber, `Rejected via Telegram by ${user}`);
      if (result.success) {
        updateTask(task.sentry_id, { state: "rejected" });
        await sendActionConfirmation("rejected", prNumber, task.short_id);
        console.log(`[Daemon] PR #${prNumber} rejected`);
      } else {
        console.error(`[Daemon] Failed to close PR #${prNumber}:`, result.error);
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: CHAT_ID,
          text: `❌ Failed to close PR #${prNumber}: ${result.error}`,
        });
      }
      break;
    }

    case "diff": {
      await answerCallback(query.id, "Fetching diff...");

      const diff = await getPRDiff(prNumber);
      await sendDiff(prNumber, diff);
      console.log(`[Daemon] Sent diff for PR #${prNumber}`);
      break;
    }

    default:
      console.log(`[Daemon] Unknown action: ${action}`);
      await answerCallback(query.id, "Unknown action");
  }
}

export async function runDaemon(): Promise<void> {
  console.log("[Daemon] ========================================");
  console.log("[Daemon] Starting Telegram callback handler...");
  console.log("[Daemon] Polling interval: 3 seconds");
  console.log("[Daemon] Press Ctrl+C to stop");
  console.log("[Daemon] ========================================");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("[Daemon] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set!");
    process.exit(1);
  }

  // Clear any pending updates on startup
  try {
    await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
      params: { offset: -1 },
    });
    console.log("[Daemon] Cleared pending updates");
  } catch (error) {
    console.log("[Daemon] Could not clear pending updates");
  }

  while (true) {
    try {
      const updates = await pollUpdates();

      for (const update of updates) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);

        if (update.callback_query) {
          await handleCallback(update.callback_query);
        }
      }
    } catch (error: any) {
      console.error("[Daemon] Error in poll loop:", error.message);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}
