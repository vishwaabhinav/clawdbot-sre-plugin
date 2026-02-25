import { execSync } from "child_process";

const REPO_PATH = "/home/clawdbot/repos/nomie-monorepo";
const REPO = "tangentad/nomie";

export interface ReviewThread {
  id: number;
  path: string;
  line: number;
  body: string;
  author: string;
  createdAt: string;
  isResolved: boolean;
}

export async function getUnresolvedThreads(prNumber: number): Promise<ReviewThread[]> {
  try {
    // Get all review comments on the PR
    const output = execSync(
      `gh api repos/${REPO}/pulls/${prNumber}/comments --jq '.[] | select(.in_reply_to_id == null) | {id: .id, path: .path, line: (.line // .original_line), body: .body, author: .user.login, createdAt: .created_at}'`,
      { cwd: REPO_PATH, encoding: "utf-8", timeout: 30000 }
    );

    if (!output.trim()) return [];

    const threads: ReviewThread[] = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line);
        return { ...parsed, isResolved: false };
      });

    // Filter to only unresolved (no reply from bot yet)
    const resolvedIds = await getResolvedThreadIds(prNumber);
    return threads.filter((t) => !resolvedIds.has(t.id));
  } catch (error: any) {
    console.error(`[Comments] Failed to fetch threads for PR #${prNumber}:`, error.message);
    return [];
  }
}

async function getResolvedThreadIds(prNumber: number): Promise<Set<number>> {
  try {
    // Get all replies and find which threads have bot replies
    const output = execSync(
      `gh api repos/${REPO}/pulls/${prNumber}/comments --jq '.[] | select(.in_reply_to_id != null) | select(.user.login == "clawdbot" or (.body | contains("[Bot]"))) | .in_reply_to_id'`,
      { cwd: REPO_PATH, encoding: "utf-8", timeout: 30000 }
    );

    const ids = output.trim().split("\n").filter(Boolean).map(Number);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function replyToThread(prNumber: number, commentId: number, body: string): Promise<boolean> {
  try {
    execSync(
      `gh api repos/${REPO}/pulls/${prNumber}/comments/${commentId}/replies -f body="${body.replace(/"/g, '\\"')}"`,
      { cwd: REPO_PATH, encoding: "utf-8", timeout: 15000 }
    );
    return true;
  } catch (error: any) {
    console.error(`[Comments] Failed to reply to comment ${commentId}:`, error.message);
    return false;
  }
}

export async function getPRStatus(prNumber: number): Promise<"open" | "merged" | "closed"> {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --json state --jq '.state'`,
      { cwd: REPO_PATH, encoding: "utf-8", timeout: 15000 }
    );
    const state = output.trim().toUpperCase();
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "open";
  } catch {
    return "closed";
  }
}

export interface OpenPR {
  number: number;
  title: string;
  branch: string;
  url: string;
}

export async function getOpenBotPRs(): Promise<OpenPR[]> {
  try {
    // Get all open PRs with branches starting with "fix/sentry-"
    const output = execSync(
      `gh pr list --state open --json number,title,headRefName,url --jq '.[] | select(.headRefName | startswith("fix/sentry-")) | {number: .number, title: .title, branch: .headRefName, url: .url}'`,
      { cwd: REPO_PATH, encoding: "utf-8", timeout: 30000 }
    );

    if (!output.trim()) return [];

    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error: any) {
    console.error(`[Comments] Failed to fetch open PRs:`, error.message);
    return [];
  }
}
