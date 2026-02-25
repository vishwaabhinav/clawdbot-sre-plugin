import axios from "axios";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

export interface PRNotification {
  shortId: string;
  prNumber: number;
  prUrl: string;
  errorTitle: string;
  errorFunction: string;
  errorCount: number;
  rootCause: string;
  fixSummary: string;
  filesChanged: string[];
  testsAdded: boolean;
  confidence?: string;
}

export async function sendPRNotification(pr: PRNotification): Promise<void> {
  const filesStr = pr.filesChanged.length > 0
    ? pr.filesChanged.map(f => f.split("/").pop()).join(", ")
    : "See PR";

  const text = `🔧 *AUTO-FIX PR #${pr.prNumber}* for ${pr.shortId}

📛 *Error:* ${escapeMarkdown(truncate(pr.errorTitle, 100))}
📍 *Function:* \`${truncate(pr.errorFunction, 50)}\`
📊 *Occurrences:* ${pr.errorCount}

🔍 *Root Cause:*
${escapeMarkdown(truncate(pr.rootCause, 200))}

✅ *Fix:*
${escapeMarkdown(truncate(pr.fixSummary, 200))}

📁 *Files:* ${filesStr}
🧪 *Tests:* ${pr.testsAdded ? "Added" : "None"}
🎯 *Confidence:* ${pr.confidence || "unknown"}

🔗 [View PR](${pr.prUrl})`;

  await sendMessage(text);
}

export async function sendFailureNotification(
  shortId: string,
  errorTitle: string,
  failureReason: string,
  sentryLink: string
): Promise<void> {
  const text = `⚠️ *AUTO-FIX FAILED* for ${shortId}

📛 *Error:* ${escapeMarkdown(truncate(errorTitle, 100))}

❌ *Reason:*
${escapeMarkdown(truncate(failureReason, 300))}

🔗 [View in Sentry](${sentryLink})

_Manual investigation required._`;

  await sendMessage(text);
}

export async function sendActionConfirmation(
  action: "merged" | "rejected",
  prNumber: number,
  shortId: string
): Promise<void> {
  const emoji = action === "merged" ? "✅" : "🚫";
  const verb = action === "merged" ? "merged" : "rejected";

  await sendMessage(`${emoji} PR #${prNumber} for ${shortId} has been ${verb}.`);
}

export async function sendDiff(prNumber: number, diff: string): Promise<void> {
  const truncatedDiff = diff.length > 3500
    ? diff.slice(0, 3500) + "\n... (truncated)"
    : diff;

  await sendMessage(`📄 *Diff for PR #${prNumber}:*\n\n\`\`\`diff\n${truncatedDiff}\n\`\`\``);
}

export async function answerCallback(callbackId: string, text: string): Promise<void> {
  // No-op since we're not using callbacks anymore
}

export async function sendFeedbackNotification(
  prNumber: number,
  shortId: string,
  prUrl: string,
  changes: Array<{ comment_id: number; summary: string }>
): Promise<void> {
  const addressed = changes.filter((c) => !c.summary.startsWith("SKIPPED"));
  const skipped = changes.filter((c) => c.summary.startsWith("SKIPPED"));

  let text = `🔄 *PR #${prNumber} Updated* — ${shortId}\n\n`;

  if (addressed.length > 0) {
    text += `Addressed ${addressed.length} comment${addressed.length > 1 ? "s" : ""}:\n`;
    text += addressed.map((c) => `• ${truncate(c.summary, 60)}`).join("\n");
    text += "\n";
  }

  if (skipped.length > 0) {
    text += `\n⚠️ Couldn't address ${skipped.length}:\n`;
    text += skipped.map((c) => `• ${truncate(c.summary.replace("SKIPPED: ", ""), 60)}`).join("\n");
  }

  text += `\n\n🔗 [View PR](${prUrl})`;

  await sendMessage(text);
}

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("[Telegram] Not configured, would send:", text.slice(0, 100));
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  } catch (error: any) {
    if (error?.response?.status === 400) {
      console.log("[Telegram] Markdown failed, retrying without formatting");
      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: CHAT_ID,
        text: text.replace(/[*`_\[\]()~]/g, ""),
        disable_web_page_preview: true,
      });
    } else {
      throw error;
    }
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}
