import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const client = new CloudWatchClient({ region: "us-east-1" });

async function checkMetrics() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const response = await client.send(
    new GetMetricDataCommand({
      StartTime: sevenDaysAgo,
      EndTime: now,
      MetricDataQueries: [
        {
          Id: "errors",
          MetricStat: {
            Metric: {
              Namespace: "AWS/Lambda",
              MetricName: "Errors",
              Dimensions: [],
            },
            Period: 3600, // 1 hour buckets
            Stat: "Sum",
          },
        },
      ],
    })
  );

  console.log("Lambda Errors (last 7 days, hourly):\n");
  const results = response.MetricDataResults?.[0];
  if (results?.Values && results?.Timestamps) {
    const combined = results.Timestamps.map((t, i) => ({
      time: t,
      value: results.Values![i]
    })).filter(x => x.value > 0).sort((a,b) => b.time!.getTime() - a.time!.getTime());
    
    for (const item of combined.slice(0, 20)) {
      console.log(`${item.time?.toISOString()}: ${item.value} errors`);
    }
    console.log(`\nTotal: ${combined.reduce((a, b) => a + b.value, 0)} errors over 7 days`);
  }
}

checkMetrics().catch(console.error);
