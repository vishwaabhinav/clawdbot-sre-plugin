import axios from "axios";

interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  shortId: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  platform?: string;
  metadata: {
    type?: string;
    value?: string;
    function?: string;
    filename?: string;
  };
  tags?: Array<{ key: string; value: string }>;
}

interface SentryEvent {
  id: string;
  message?: string;
  culprit?: string;
  context?: Record<string, any>;
  entries?: Array<{
    type: string;
    data: {
      values?: Array<{
        type: string;
        value: string;
        stacktrace?: {
          frames: Array<{
            filename: string;
            function: string;
            lineNo: number;
            colNo: number;
            context?: Array<[number, string]>;
          }>;
        };
      }>;
    };
  }>;
  tags?: Array<{ key: string; value: string }>;
}

export interface SentryAlert {
  type: "sentry";
  issueId: string;
  shortId: string;
  title: string;
  function: string;
  count: number;
  link: string;
  firstSeen: string;
  lastSeen: string;
  stackTrace?: string;
  filename?: string;
  errorType?: string;
  tags?: Record<string, string>;
}

async function getLatestEvent(
  authToken: string,
  org: string,
  issueId: string
): Promise<SentryEvent | null> {
  try {
    const response = await axios.get<SentryEvent[]>(
      `https://sentry.io/api/0/issues/${issueId}/events/`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        params: { limit: 1 },
      }
    );
    return response.data[0] || null;
  } catch (error) {
    console.error(`Error fetching event for issue ${issueId}:`, error);
    return null;
  }
}

function extractStackTrace(event: SentryEvent): string | undefined {
  if (!event.entries) return undefined;
  
  for (const entry of event.entries) {
    if (entry.type === "exception" && entry.data.values) {
      const exc = entry.data.values[0];
      if (exc?.stacktrace?.frames) {
        // Get the last 3 frames (most relevant)
        const frames = exc.stacktrace.frames.slice(-3).reverse();
        return frames
          .map(f => `  at ${f.function || "?"} (${f.filename}:${f.lineNo})`)
          .join("\n");
      }
    }
  }
  return undefined;
}

export async function pollSentry(
  authToken: string,
  org: string,
  project: string,
  seenIssueIds: string[] = []
): Promise<SentryAlert[]> {
  const alerts: SentryAlert[] = [];
  const seenSet = new Set(seenIssueIds);

  try {
    // Get unresolved issues
    const response = await axios.get<SentryIssue[]>(
      `https://sentry.io/api/0/projects/${org}/${project}/issues/`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        params: { query: "is:unresolved", statsPeriod: "24h" },
      }
    );

    for (const issue of response.data) {
      // Skip already-seen issues - dedup happens here now
      if (seenSet.has(issue.id)) continue;

      // Fetch latest event for richer context
      const event = await getLatestEvent(authToken, org, issue.id);
      const stackTrace = event ? extractStackTrace(event) : undefined;
      
      // Extract tags as object
      const tags: Record<string, string> = {};
      if (issue.tags) {
        for (const tag of issue.tags) {
          tags[tag.key] = tag.value;
        }
      }

      alerts.push({
        type: "sentry",
        issueId: issue.id,
        shortId: issue.shortId,
        title: issue.title,
        function: issue.culprit || issue.metadata?.function || "unknown",
        count: parseInt(issue.count, 10),
        link: issue.permalink,
        firstSeen: issue.firstSeen,
        lastSeen: issue.lastSeen,
        stackTrace,
        filename: issue.metadata?.filename,
        errorType: issue.metadata?.type,
        tags,
      });
      
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }
  } catch (error) {
    console.error("Sentry poll error:", error);
  }

  return alerts;
}
