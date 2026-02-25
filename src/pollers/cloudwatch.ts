import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

interface CloudWatchAlert {
  type: "cloudwatch";
  metric: string;
  resource: string;
  value: number;
  threshold: number;
}

const client = new CloudWatchClient({ region: process.env.AWS_REGION || "us-east-1" });

const METRICS = [
  { id: "lambda_errors", namespace: "AWS/Lambda", name: "Errors", label: "Lambda Errors", resource: "nomie-prod" },
  { id: "lambda_throttles", namespace: "AWS/Lambda", name: "Throttles", label: "Lambda Throttles", resource: "nomie-prod" },
  { id: "apigw_5xx", namespace: "AWS/ApiGateway", name: "5XXError", label: "API Gateway 5xx", resource: "Api" },
  { id: "dynamo_throttles", namespace: "AWS/DynamoDB", name: "ThrottledRequests", label: "DynamoDB Throttles", resource: "Table" },
];

export async function pollCloudWatch(): Promise<CloudWatchAlert[]> {
  const alerts: CloudWatchAlert[] = [];
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  try {
    const metricsResponse = await client.send(
      new GetMetricDataCommand({
        StartTime: fiveMinutesAgo,
        EndTime: now,
        MetricDataQueries: METRICS.map(m => ({
          Id: m.id,
          MetricStat: {
            Metric: { Namespace: m.namespace, MetricName: m.name, Dimensions: [] },
            Period: 300,
            Stat: "Sum",
          },
        })),
      })
    );

    const metricLookup = new Map(METRICS.map(m => [m.id, m]));

    for (const result of metricsResponse.MetricDataResults || []) {
      const value = result.Values?.[0] || 0;
      const meta = metricLookup.get(result.Id!);
      if (value > 0 && meta) {
        alerts.push({ type: "cloudwatch", metric: meta.label, resource: meta.resource, value, threshold: 0 });
      }
    }
  } catch (error) {
    console.error("CloudWatch poll error:", error);
  }

  return alerts;
}
