import axios from "axios";

interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  shortId: string;
  count: string;
  permalink: string;
  metadata: {
    type?: string;
    function?: string;
  };
}

interface SentryEvent {
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
          }>;
        };
      }>;
    };
  }>;
}

export interface SentryAlert {
  type: "sentry";
  issueId: string;
  shortId: string;
  title: string;
  function: string;
  count: number;
  link: string;
  stackTrace?: string;
  errorType?: string;
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
  for (const entry of event.entries || []) {
    if (entry.type === "exception" && entry.data.values) {
      const frames = entry.data.values[0]?.stacktrace?.frames;
      if (frames) {
        return frames
          .slice(-3)
          .reverse()
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
    const response = await axios.get<SentryIssue[]>(
      `https://sentry.io/api/0/projects/${org}/${project}/issues/`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        params: { query: "is:unresolved", statsPeriod: "24h" },
      }
    );

    for (const issue of response.data) {
      if (seenSet.has(issue.id)) continue;

      const event = await getLatestEvent(authToken, org, issue.id);

      alerts.push({
        type: "sentry",
        issueId: issue.id,
        shortId: issue.shortId,
        title: issue.title,
        function: issue.culprit || issue.metadata?.function || "unknown",
        count: parseInt(issue.count, 10),
        link: issue.permalink,
        stackTrace: event ? extractStackTrace(event) : undefined,
        errorType: issue.metadata?.type,
      });

      await new Promise(r => setTimeout(r, 100));
    }
  } catch (error) {
    console.error("Sentry poll error:", error);
  }

  return alerts;
}
