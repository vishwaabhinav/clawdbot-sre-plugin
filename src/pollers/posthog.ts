import axios from "axios";

interface PostHogAlert {
  type: "posthog";
  metric: string;
  current: number;
  baseline: number;
  changePercent: number;
}

const POSTHOG_HOST = "https://us.posthog.com";

async function queryTrend(
  apiKey: string,
  projectId: string,
  event: string,
  math: string,
  dateFrom: string,
  dateTo: string
): Promise<number[]> {
  const response = await axios.post(
    `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
    {
      query: {
        kind: "TrendsQuery",
        series: [{ kind: "EventsNode", event, math }],
        dateRange: { date_from: dateFrom, date_to: dateTo },
        interval: "day",
      },
    },
    { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
  );
  return response.data?.results?.[0]?.data || [];
}

function detectAnomaly(data: number[], metric: string, threshold: number): PostHogAlert | null {
  if (data.length < 2) return null;

  const today = data[data.length - 1] || 0;
  const avg = data.slice(0, -1).reduce((a, b) => a + b, 0) / (data.length - 1);
  if (avg <= 0) return null;

  const changePercent = ((today - avg) / avg) * 100;
  if (Math.abs(changePercent) <= threshold) return null;
  // For DAU, only alert on drops (negative change)
  if (threshold < 50 && changePercent > 0) return null;

  return {
    type: "posthog",
    metric,
    current: today,
    baseline: Math.round(avg),
    changePercent: Math.round(changePercent),
  };
}

export async function pollPostHog(
  apiKey: string,
  projectId: string
): Promise<PostHogAlert[]> {
  const alerts: PostHogAlert[] = [];
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateFrom = sevenDaysAgo.toISOString().split("T")[0];
  const dateTo = now.toISOString().split("T")[0];

  try {
    // DAU: alert on >30% drop
    const dauData = await queryTrend(apiKey, projectId, "$pageview", "dau", dateFrom, dateTo);
    const dauAlert = detectAnomaly(dauData, "DAU", 30);
    if (dauAlert) alerts.push(dauAlert);

    // Key events: alert on >50% spike or drop
    for (const event of ["login", "signup", "api_error", "subscription_started"]) {
      const data = await queryTrend(apiKey, projectId, event, "total", dateFrom, dateTo);
      const alert = detectAnomaly(data, event, 50);
      if (alert) alerts.push(alert);
    }
  } catch (error) {
    console.error("PostHog poll error:", error);
  }

  return alerts;
}
