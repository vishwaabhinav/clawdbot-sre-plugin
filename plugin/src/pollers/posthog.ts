import axios from "axios";
import type { PostHogAlert } from "../types.js";

const POSTHOG_HOST = "https://us.i.posthog.com";

export interface DailySummary {
  date: string;
  dau: number;
  dauChange: number;
  dauAvg: number;
  events: {
    name: string;
    count: number;
    change: number;
    avg: number;
  }[];
  totalPageviews: number;
  pageviewsChange: number;
}

export async function getDailySummary(
  apiKey: string,
  projectId: string
): Promise<DailySummary | null> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateStr = now.toISOString().split("T")[0];

  try {
    // Get DAU
    const dauResponse = await axios.post(
      `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
      {
        query: {
          kind: "TrendsQuery",
          series: [{ kind: "EventsNode", event: "$pageview", math: "dau" }],
          dateRange: {
            date_from: sevenDaysAgo.toISOString().split("T")[0],
            date_to: dateStr,
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
    const todayDau = dauResults[dauResults.length - 1] || 0;
    const dauAvg = dauResults.length > 1
      ? dauResults.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (dauResults.length - 1)
      : 0;
    const dauChange = dauAvg > 0 ? ((todayDau - dauAvg) / dauAvg) * 100 : 0;

    // Get total pageviews
    const pvResponse = await axios.post(
      `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
      {
        query: {
          kind: "TrendsQuery",
          series: [{ kind: "EventsNode", event: "$pageview", math: "total" }],
          dateRange: {
            date_from: sevenDaysAgo.toISOString().split("T")[0],
            date_to: dateStr,
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

    const pvResults = pvResponse.data?.results?.[0]?.data || [];
    const todayPv = pvResults[pvResults.length - 1] || 0;
    const pvAvg = pvResults.length > 1
      ? pvResults.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (pvResults.length - 1)
      : 0;
    const pvChange = pvAvg > 0 ? ((todayPv - pvAvg) / pvAvg) * 100 : 0;

    // Get key events
    const keyEvents = ["login", "signup", "subscription_started", "journal_entry_created", "chat_message_sent"];
    const eventStats: DailySummary["events"] = [];

    for (const eventName of keyEvents) {
      try {
        const eventResponse = await axios.post(
          `${POSTHOG_HOST}/api/projects/${projectId}/query/`,
          {
            query: {
              kind: "TrendsQuery",
              series: [{ kind: "EventsNode", event: eventName, math: "total" }],
              dateRange: {
                date_from: sevenDaysAgo.toISOString().split("T")[0],
                date_to: dateStr,
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
        const today = results[results.length - 1] || 0;
        const avg = results.length > 1
          ? results.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (results.length - 1)
          : 0;
        const change = avg > 0 ? ((today - avg) / avg) * 100 : 0;

        eventStats.push({
          name: eventName,
          count: today,
          change: Math.round(change),
          avg: Math.round(avg),
        });
      } catch {
        // Event might not exist, skip it
      }
    }

    return {
      date: dateStr,
      dau: todayDau,
      dauChange: Math.round(dauChange),
      dauAvg: Math.round(dauAvg),
      events: eventStats,
      totalPageviews: todayPv,
      pageviewsChange: Math.round(pvChange),
    };
  } catch (error) {
    console.error("[nomie-sre] PostHog summary error:", error);
    return null;
  }
}

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
    console.error("[nomie-sre] PostHog poll error:", error);
  }

  return alerts;
}
