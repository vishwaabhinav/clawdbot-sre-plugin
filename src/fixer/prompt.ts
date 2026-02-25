export interface ErrorContext {
  sentryId: string;
  shortId: string;
  title: string;
  function: string;
  count: number;
  stackTrace: string;
  permalink: string;
}

export function buildFixPrompt(error: ErrorContext, branch: string): string {
  return `You are investigating a production error in nomie-monorepo.

ERROR DETAILS:
- Sentry ID: ${error.shortId}
- Title: ${error.title}
- Function: ${error.function}
- Count: ${error.count} occurrences
- Environment: prod

STACK TRACE:
${error.stackTrace}

SENTRY LINK: ${error.permalink}

INSTRUCTIONS:
1. First, ensure you're on a clean main branch:
   git checkout main && git pull origin main
2. Read the relevant files to understand the error context
3. Identify the root cause of the error
4. Create and checkout a new branch from main:
   git checkout -b ${branch}
5. Implement a minimal fix (fix only what's broken, don't refactor)
6. Add or update tests if appropriate for the fix
7. Commit with a message starting with "fix: "
8. Push the branch to origin
9. Create a PR to main using: gh pr create --title "fix: <brief description>" --body "Fixes ${error.shortId}"

CRITICAL: When completely done, output ONLY this JSON block (no other text before or after):

\`\`\`json
{
  "status": "pr_created",
  "pr_number": <the PR number as integer>,
  "pr_url": "<full PR URL>",
  "root_cause": "<1-2 sentence explanation of what caused the error>",
  "fix_summary": "<1-2 sentence description of what you fixed>",
  "files_changed": ["<file1>", "<file2>"],
  "tests_added": <true or false>,
  "confidence": "high" or "medium" or "low"
}
\`\`\`

If you cannot fix the issue for any reason, output:

\`\`\`json
{
  "status": "failed",
  "error": "<explanation of why you could not fix it>"
}
\`\`\``;
}
