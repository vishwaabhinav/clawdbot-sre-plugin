import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({ region: "us-east-1" });

async function search() {
  const startTime = new Date('2026-03-02T16:30:00Z').getTime();
  const endTime = new Date('2026-03-02T18:00:00Z').getTime();
  
  // Check both environments
  for (const prefix of ['nomie-prod', 'nomie-abhinav']) {
    const groups = await client.send(new DescribeLogGroupsCommand({ 
      logGroupNamePrefix: `/aws/lambda/${prefix}`,
      limit: 50 
    }));
    
    console.log(`\n=== ${prefix} (${groups.logGroups?.length} groups) ===\n`);
    
    for (const group of groups.logGroups || []) {
      try {
        // Look for REPORT lines with errors or timeouts
        const logs = await client.send(new FilterLogEventsCommand({
          logGroupName: group.logGroupName!,
          startTime,
          endTime,
          filterPattern: 'REPORT',
          limit: 10,
        }));
        
        for (const e of logs.events || []) {
          // Only show errors or timeouts
          if (e.message?.includes('Error') || e.message?.includes('Timeout') || e.message?.includes('timed out')) {
            const funcName = group.logGroupName!.split('-').slice(-2, -1)[0];
            console.log(`${funcName}: ${e.message?.slice(0, 200)}`);
          }
        }
      } catch {}
    }
  }
}

search().catch(console.error);
