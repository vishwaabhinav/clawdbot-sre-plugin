import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const client = new CloudWatchLogsClient({ region: "us-east-1" });

async function search() {
  // Get ALL log groups (not just nomie-prod)
  const groups = await client.send(new DescribeLogGroupsCommand({ limit: 50 }));
  
  console.log(`Found ${groups.logGroups?.length} total log groups:`);
  for (const g of groups.logGroups || []) {
    console.log(`  ${g.logGroupName}`);
  }
  
  // Search nomie groups with broad error pattern
  const nomieGroups = groups.logGroups?.filter(g => 
    g.logGroupName?.includes('nomie')
  ) || [];
  
  console.log(`\nSearching ${nomieGroups.length} nomie log groups...\n`);
  
  const startTime = new Date('2026-03-02T16:00:00Z').getTime();
  const endTime = new Date('2026-03-02T18:30:00Z').getTime();
  
  for (const group of nomieGroups) {
    try {
      // Just get recent logs without filter to see what's there
      const logs = await client.send(new FilterLogEventsCommand({
        logGroupName: group.logGroupName!,
        startTime,
        endTime,
        limit: 3,
      }));
      
      if (logs.events && logs.events.length > 0) {
        console.log(`=== ${group.logGroupName} (${logs.events.length} events) ===`);
        for (const e of logs.events) {
          console.log(e.message?.slice(0, 200));
        }
        console.log('');
      }
    } catch {}
  }
}

search().catch(console.error);
