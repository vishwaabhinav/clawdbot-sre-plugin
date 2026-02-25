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

// Lambda functions to monitor (nomie-prod prefix)
const LAMBDA_PREFIX = "nomie-prod";

export async function pollCloudWatch(): Promise<CloudWatchAlert[]> {
  const alerts: CloudWatchAlert[] = [];
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  try {
    // Query Lambda errors, throttles, and duration
    const metricsResponse = await client.send(
      new GetMetricDataCommand({
        StartTime: fiveMinutesAgo,
        EndTime: now,
        MetricDataQueries: [
          {
            Id: "lambda_errors",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Errors",
                Dimensions: [],
              },
              Period: 300,
              Stat: "Sum",
            },
          },
          {
            Id: "lambda_throttles",
            MetricStat: {
              Metric: {
                Namespace: "AWS/Lambda",
                MetricName: "Throttles",
                Dimensions: [],
              },
              Period: 300,
              Stat: "Sum",
            },
          },
          {
            Id: "apigw_5xx",
            MetricStat: {
              Metric: {
                Namespace: "AWS/ApiGateway",
                MetricName: "5XXError",
                Dimensions: [],
              },
              Period: 300,
              Stat: "Sum",
            },
          },
          {
            Id: "dynamo_throttles",
            MetricStat: {
              Metric: {
                Namespace: "AWS/DynamoDB",
                MetricName: "ThrottledRequests",
                Dimensions: [],
              },
              Period: 300,
              Stat: "Sum",
            },
          },
        ],
      })
    );

    for (const result of metricsResponse.MetricDataResults || []) {
      const value = result.Values?.[0] || 0;

      if (result.Id === "lambda_errors" && value > 0) {
        alerts.push({
          type: "cloudwatch",
          metric: "Lambda Errors",
          resource: LAMBDA_PREFIX,
          value,
          threshold: 0,
        });
      }

      if (result.Id === "lambda_throttles" && value > 0) {
        alerts.push({
          type: "cloudwatch",
          metric: "Lambda Throttles",
          resource: LAMBDA_PREFIX,
          value,
          threshold: 0,
        });
      }

      if (result.Id === "apigw_5xx" && value > 0) {
        alerts.push({
          type: "cloudwatch",
          metric: "API Gateway 5xx",
          resource: "Api",
          value,
          threshold: 0,
        });
      }

      if (result.Id === "dynamo_throttles" && value > 0) {
        alerts.push({
          type: "cloudwatch",
          metric: "DynamoDB Throttles",
          resource: "Table",
          value,
          threshold: 0,
        });
      }
    }
  } catch (error) {
    console.error("CloudWatch poll error:", error);
  }

  return alerts;
}
