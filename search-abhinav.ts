import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({ region: "us-east-1" });

async function search() {
  // Search nomie-abhinav groups (dev/staging environment)
  const groups = await client.send(new DescribeLogGroupsCommand({ 
    logGroupNamePrefix: "/aws/lambda/nomie-abhinav",
    limit: 50 
  }));
  
  console.log(`Searching ${groups.logGroups?.length} nomie-abhinav log groups...\n`);
  
  const startTime = new Date('2026-03-02T16:00:00Z').getTime();
  const endTime = new Date('2026-03-02T18:30:00Z').getTime();
  
  for (const group of groups.logGroups || []) {
    try {
      const logs = await client.send(new FilterLogEventsCommand({
        logGroupName: group.logGroupName!,
        startTime,
        endTime,
        filterPattern: '"ERROR" OR "Error" OR "error" OR "Exception"',
        limit: 5,
      }));
      
      if (logs.events && logs.events.length > 0) {
        const funcName = group.logGroupName!.replace('/aws/lambda/nomie-abhinav-', '');
        console.log(`=== ${funcName} ===`);
        for (const e of logs.events) {
          if (e.message?.includes('START') || e.message?.includes('END') || e.message?.includes('REPORT')) continue;
          const time = new Date(e.timestamp || 0).toISOString();
          console.log(`[${time}]`);
          console.log(e.message?.slice(0, 500));
          console.log('---');
        }
      }
    } catch {}
  }
}

search().catch(console.error);
