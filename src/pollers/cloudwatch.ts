import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { CloudWatchAlert } from "../types.js";

const LAMBDA_PREFIX = "nomie-prod";

interface LambdaErrorDetail {
  functionName: string;
  timestamp: string;
  message: string;
  requestId?: string;
}

/**
 * Fetch actual error messages from CloudWatch Logs
 */
async function fetchLambdaErrorDetails(
  logsClient: CloudWatchLogsClient,
  minutesAgo: number = 10
): Promise<LambdaErrorDetail[]> {
  const errors: LambdaErrorDetail[] = [];
  const now = Date.now();
  const startTime = now - minutesAgo * 60 * 1000;

  try {
    // Get all nomie-prod lambda log groups
    const logGroups = await logsClient.send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: `/aws/lambda/${LAMBDA_PREFIX}`,
        limit: 50,
      })
    );

    for (const group of logGroups.logGroups || []) {
      if (!group.logGroupName) continue;

      try {
        // Search for error patterns in logs
        const logs = await logsClient.send(
          new FilterLogEventsCommand({
            logGroupName: group.logGroupName,
            startTime,
            endTime: now,
            filterPattern: '?"ERROR" ?"Error" ?"error" ?"Exception" ?"Task timed out" ?"Runtime.UnhandledPromiseRejection"',
            limit: 5,
          })
        );

        for (const event of logs.events || []) {
          if (!event.message) continue;
          
          // Skip noisy/non-error logs
          if (event.message.includes('INFO') || event.message.includes('DEBUG')) continue;
          if (event.message.includes('START RequestId') || event.message.includes('END RequestId')) continue;
          if (event.message.includes('REPORT RequestId') && !event.message.includes('Error')) continue;

          // Extract function name from log group
          const functionName = group.logGroupName
            .replace('/aws/lambda/', '')
            .replace(LAMBDA_PREFIX + '-', '')
            .split('-')
            .slice(0, 2)
            .join('-');

          // Extract request ID if present
          const requestIdMatch = event.message.match(/RequestId:\s*([a-f0-9-]+)/i);

          // Clean up the message
          let message = event.message
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/g, '') // Remove timestamps
            .replace(/[a-f0-9-]{36}/gi, '[ID]') // Anonymize UUIDs
            .trim()
            .slice(0, 500); // Limit length

          errors.push({
            functionName,
            timestamp: new Date(event.timestamp || now).toISOString(),
            message,
            requestId: requestIdMatch?.[1],
          });
        }
      } catch {
        // Skip inaccessible log groups
      }
    }
  } catch (error) {
    console.error("[nomie-sre] CloudWatch Logs fetch error:", error);
  }

  // Dedupe by message similarity
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = e.functionName + ':' + e.message.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10); // Max 10 errors
}

export async function pollCloudWatch(
  region: string = "us-east-1"
): Promise<CloudWatchAlert[]> {
  const client = new CloudWatchClient({ region });
  const logsClient = new CloudWatchLogsClient({ region });
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

    let lambdaErrorCount = 0;

    for (const result of metricsResponse.MetricDataResults || []) {
      const value = result.Values?.[0] || 0;

      if (result.Id === "lambda_errors" && value > 0) {
        lambdaErrorCount = value;
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

    // If there are Lambda errors, fetch the actual error details
    if (lambdaErrorCount > 0) {
      const errorDetails = await fetchLambdaErrorDetails(logsClient, 10);
      
      if (errorDetails.length > 0) {
        // Create detailed error alerts
        for (const detail of errorDetails) {
          alerts.push({
            type: "cloudwatch",
            metric: "Lambda Error",
            resource: detail.functionName,
            value: 1,
            threshold: 0,
            details: detail.message,
            timestamp: detail.timestamp,
          });
        }
      } else {
        // Fallback if we couldn't get details
        alerts.push({
          type: "cloudwatch",
          metric: "Lambda Errors",
          resource: LAMBDA_PREFIX,
          value: lambdaErrorCount,
          threshold: 0,
          details: "Error details not available in logs",
        });
      }
    }
  } catch (error) {
    console.error("[nomie-sre] CloudWatch poll error:", error);
  }

  return alerts;
}
