import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({ region: "us-east-1" });

async function fetchErrors() {
  // Search around the time when errors occurred: 16:47 and 17:47 UTC today
  const now = new Date();
  const startTime = new Date('2026-03-02T16:00:00Z').getTime();
  const endTime = new Date('2026-03-02T18:30:00Z').getTime();

  const logGroups = await client.send(
    new DescribeLogGroupsCommand({
      logGroupNamePrefix: `/aws/lambda/nomie-prod`,
      limit: 50,
    })
  );

  console.log(`Searching ${logGroups.logGroups?.length} log groups for errors between 16:00-18:30 UTC\n`);
  
  let foundAny = false;

  for (const group of logGroups.logGroups || []) {
    if (!group.logGroupName) continue;

    try {
      // Try multiple error patterns
      for (const pattern of ['ERROR', 'Error', 'Exception', 'errorType', 'Task timed out']) {
        const logs = await client.send(
          new FilterLogEventsCommand({
            logGroupName: group.logGroupName,
            startTime,
            endTime,
            filterPattern: pattern,
            limit: 5,
          })
        );

        if (logs.events && logs.events.length > 0) {
          for (const event of logs.events) {
            if (!event.message) continue;
            // Skip non-error logs
            if (event.message.includes('START RequestId')) continue;
            if (event.message.includes('END RequestId')) continue;
            if (event.message.includes('REPORT RequestId') && !event.message.includes('Error')) continue;
            if (event.message.includes('INFO')) continue;
            
            foundAny = true;
            const funcName = group.logGroupName.replace('/aws/lambda/nomie-prod-', '');
            const time = new Date(event.timestamp || 0).toISOString();
            console.log(`=== ${funcName} ===`);
            console.log(`Time: ${time}`);
            console.log(`Message:\n${event.message.slice(0, 600)}`);
            console.log('---\n');
          }
        }
      }
    } catch (e) {
      // Skip
    }
  }
  
  if (!foundAny) {
    console.log("No error logs found in the specified time range.");
    console.log("The errors might be from a different log group or pattern.");
  }
}

fetchErrors().catch(console.error);
