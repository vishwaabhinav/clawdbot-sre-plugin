import axios from "axios";

interface PostHogAlert {
  type: "posthog";
  metric: string;
  current: number;
  baseline: number;
  changePercent: number;
}

const POSTHOG_HOST = "https://us.posthog.com";

export async function pollPostHog(
  apiKey: string,
  projectId: string
): Promise<PostHogAlert[]> {
  const alerts: PostHogAlert[] = [];
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    // Query DAU for today vs 7-day average
    const dauResponse = await axios.post(
      `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
      {
        query: {
          kind: "TrendsQuery",
          series: [
            {
              kind: "EventsNode",
              event: "$pageview",
              math: "dau",
            },
          ],
          dateRange: {
            date_from: sevenDaysAgo.toISOString().split("T")[0],
            date_to: now.toISOString().split("T")[0],
          },
          interval: "day",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const dauResults = dauResponse.data?.results?.[0]?.data || [];
    if (dauResults.length >= 2) {
      const todayDau = dauResults[dauResults.length - 1] || 0;
      const avgDau =
        dauResults.slice(0, -1).reduce((a: number, b: number) => a + b, 0) /
        (dauResults.length - 1);

      if (avgDau > 0) {
        const changePercent = ((todayDau - avgDau) / avgDau) * 100;
        // Alert if DAU dropped more than 30%
        if (changePercent < -30) {
          alerts.push({
            type: "posthog",
            metric: "DAU",
            current: todayDau,
            baseline: Math.round(avgDau),
            changePercent: Math.round(changePercent),
          });
        }
      }
    }

    // Query key events for anomalies
    const keyEvents = ["login", "signup", "api_error", "subscription_started"];
    for (const eventName of keyEvents) {
      const eventResponse = await axios.post(
        `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
        {
          query: {
            kind: "TrendsQuery",
            series: [
              {
                kind: "EventsNode",
                event: eventName,
                math: "total",
              },
            ],
            dateRange: {
              date_from: sevenDaysAgo.toISOString().split("T")[0],
              date_to: now.toISOString().split("T")[0],
            },
            interval: "day",
          },
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const results = eventResponse.data?.results?.[0]?.data || [];
      if (results.length >= 2) {
        const today = results[results.length - 1] || 0;
        const avg =
          results.slice(0, -1).reduce((a: number, b: number) => a + b, 0) /
          (results.length - 1);

        if (avg > 0) {
          const changePercent = ((today - avg) / avg) * 100;
          // Alert on >50% spike or drop
          if (Math.abs(changePercent) > 50) {
            alerts.push({
              type: "posthog",
              metric: eventName,
              current: today,
              baseline: Math.round(avg),
              changePercent: Math.round(changePercent),
            });
          }
        }
      }
    }
  } catch (error) {
    console.error("PostHog poll error:", error);
  }

  return alerts;
}
