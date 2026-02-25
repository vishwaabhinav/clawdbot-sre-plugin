import { execSync } from "child_process";

const REPO_PATH = "/home/clawdbot/repos/nomie-monorepo";

export interface PRResult {
  success: boolean;
  error?: string;
}

export async function mergePR(prNumber: number): Promise<PRResult> {
  try {
    console.log(`[GitHub] Merging PR #${prNumber}...`);
    execSync(`gh pr merge ${prNumber} --squash --delete-branch`, {
      cwd: REPO_PATH,
      stdio: "pipe",
      timeout: 30000,
    });
    console.log(`[GitHub] PR #${prNumber} merged successfully`);
    return { success: true };
  } catch (error: any) {
    const message = error.stderr?.toString() || error.message;
    console.error(`[GitHub] Failed to merge PR #${prNumber}:`, message);
    return { success: false, error: message };
  }
}

export async function closePR(prNumber: number, comment?: string): Promise<PRResult> {
  try {
    console.log(`[GitHub] Closing PR #${prNumber}...`);

    if (comment) {
      const safeComment = comment.replace(/"/g, '\\"');
      execSync(`gh pr comment ${prNumber} --body "${safeComment}"`, {
        cwd: REPO_PATH,
        stdio: "pipe",
        timeout: 15000,
      });
    }

    execSync(`gh pr close ${prNumber} --delete-branch`, {
      cwd: REPO_PATH,
      stdio: "pipe",
      timeout: 15000,
    });

    console.log(`[GitHub] PR #${prNumber} closed`);
    return { success: true };
  } catch (error: any) {
    const message = error.stderr?.toString() || error.message;
    console.error(`[GitHub] Failed to close PR #${prNumber}:`, message);
    return { success: false, error: message };
  }
}

export async function getPRDiff(prNumber: number): Promise<string> {
  try {
    console.log(`[GitHub] Getting diff for PR #${prNumber}...`);
    const diff = execSync(`gh pr diff ${prNumber}`, {
      cwd: REPO_PATH,
      stdio: "pipe",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }).toString();

    return diff;
  } catch (error: any) {
    const message = error.stderr?.toString() || error.message;
    console.error(`[GitHub] Failed to get diff for PR #${prNumber}:`, message);
    return `Error getting diff: ${message}`;
  }
}

export async function pullLatest(): Promise<void> {
  try {
    console.log("[GitHub] Pulling latest from main...");
    execSync("git fetch origin main && git checkout main && git reset --hard origin/main", {
      cwd: REPO_PATH,
      stdio: "pipe",
      timeout: 30000,
    });
    console.log("[GitHub] Successfully pulled latest");
  } catch (error: any) {
    console.error("[GitHub] Failed to pull latest:", error.message);
    throw error;
  }
}
