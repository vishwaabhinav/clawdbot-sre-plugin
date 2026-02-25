# SRE Monitoring Plugin for Clawdbot

A Clawdbot plugin that provides automated SRE (Site Reliability Engineering) monitoring by polling multiple observability platforms and alerting on issues.

## Features

- **Multi-source monitoring**: Polls Sentry, PostHog, and AWS CloudWatch
- **Smart alerting**: Only alerts on new issues, avoids duplicate notifications
- **Daily summaries**: Automated daily usage reports from PostHog (DAU, pageviews, key events)
- **Silence support**: Temporarily mute alerts during maintenance windows
- **Background polling**: Runs automatically every 5 minutes (configurable)

## Monitored Sources

### Sentry
- Detects new error issues
- Provides stack traces and error context
- Tracks seen issues to avoid duplicate alerts

### PostHog
- **Anomaly detection**: Alerts when metrics deviate >30-50% from 7-day baseline
- **Daily summaries**: DAU, pageviews, and key event counts with trend indicators
- Tracks: login, signup, subscription events, and custom events

### CloudWatch
- Monitors AWS Lambda errors and invocations
- Alerts on elevated error rates

## Agent Tools

| Tool | Description |
|------|-------------|
| `nomie_sre_poll` | Manually trigger a poll cycle |
| `nomie_sre_status` | Show monitoring status and configuration |
| `nomie_sre_silence` | Silence alerts for N minutes |
| `nomie_sre_summary` | Get/send daily PostHog usage summary |

## CLI Commands

```bash
clawdbot nomie-sre status              # Show current status
clawdbot nomie-sre poll                # Manual poll
clawdbot nomie-sre alerts              # Show recent alerts
clawdbot nomie-sre silence 30          # Silence for 30 minutes
clawdbot nomie-sre unsilence           # Resume alerts
clawdbot nomie-sre summary             # Show daily summary
clawdbot nomie-sre summary --send      # Send summary to alert channel
```

## Configuration

Add to your `clawdbot.json` under `plugins.entries`:

```json
{
  "nomie-sre": {
    "enabled": true,
    "config": {
      "sentryAuthToken": "sntryu_xxx",
      "sentryOrg": "your-org",
      "sentryProject": "your-project",
      "posthogApiKey": "phx_xxx",
      "posthogProjectId": "12345",
      "awsRegion": "us-east-1",
      "pollIntervalMinutes": 5,
      "alertChannel": "telegram",
      "alertChatId": "-100xxxxxxxxxx"
    }
  }
}
```

## Alert Channels

Currently supports:
- **Telegram**: Sends markdown-formatted alerts to a group/channel
- **Slack**: Basic text alerts (planned)

## Daily Summary

The plugin automatically sends a daily usage summary at 9 AM UTC containing:
- Daily Active Users (DAU) with change vs 7-day average
- Total pageviews with trend
- Key event counts (logins, signups, etc.)

## License

MIT
