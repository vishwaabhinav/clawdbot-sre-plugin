import { ReviewThread } from "../github/comments.js";

export interface FeedbackContext {
  prNumber: number;
  prTitle: string;
  branch: string;
  threads: ReviewThread[];
}

export function buildFeedbackPrompt(ctx: FeedbackContext): string {
  const threadList = ctx.threads
    .map((t) => `[Comment ID: ${t.id}] ${t.path}:${t.line} @${t.author}:\n   "${t.body}"`)
    .join("\n\n");

  return `You are addressing PR review feedback on nomie-monorepo.

PR #${ctx.prNumber}: ${ctx.prTitle}
Branch: ${ctx.branch}

UNRESOLVED REVIEW COMMENTS:
${threadList}

INSTRUCTIONS:
1. Run: git fetch origin && git checkout ${ctx.branch} && git pull origin ${ctx.branch}
2. Read the relevant files to understand context
3. Address each comment with minimal, focused changes
4. Do NOT refactor unrelated code or add unnecessary features
5. Commit with message: "fix: address PR feedback"
6. Push: git push origin ${ctx.branch}

CRITICAL: When completely done, output ONLY this JSON block (use the EXACT comment IDs from above):

\`\`\`json
{
  "status": "addressed",
  "changes": [
    {"comment_id": <exact_id_from_above>, "summary": "<what you did>"}
  ],
  "files_changed": ["<file1>", "<file2>"]
}
\`\`\`

If you cannot address a comment, include it as:
{"comment_id": <exact_id_from_above>, "summary": "SKIPPED: <reason>"}
`;
}
