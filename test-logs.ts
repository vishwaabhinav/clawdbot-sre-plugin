import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const region = "us-east-1";
const client = new CloudWatchLogsClient({ region });
const LAMBDA_PREFIX = "nomie-prod";

async function fetchErrors() {
  const now = Date.now();
  const startTime = now - 24 * 60 * 60 * 1000;

  const logGroups = await client.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: `/aws/lambda/${LAMBDA_PREFIX}`,
      limit: 50,
    })
  );

  console.log(`Found ${logGroups.logGroups?.length} log groups\n`);

  for (const group of logGroups.logGroups || []) {
    if (!group.logGroupName) continue;

    try {
      const logs = await client.send(
        new FilterLogEventsCommand({
          logGroupName: group.logGroupName,
          startTime,
          endTime: now,
          filterPattern: '?"ERROR" ?"Error" ?"Exception" ?"Task timed out"',
          limit: 3,
        })
      );

      if (logs.events && logs.events.length > 0) {
        const funcName = group.logGroupName.replace('/aws/lambda/nomie-prod-', '');
        console.log(`=== ${funcName} ===`);
        for (const event of logs.events) {
          if (!event.message) continue;
          if (event.message.includes('START RequestId') || event.message.includes('END RequestId')) continue;
          if (event.message.includes('REPORT RequestId') && !event.message.includes('Error')) continue;
          
          const time = new Date(event.timestamp || 0).toISOString();
          console.log(`[${time}]`);
          console.log(event.message.slice(0, 400));
          console.log('---');
        }
      }
    } catch {
      // Skip
    }
  }
}

fetchErrors().catch(console.error);
