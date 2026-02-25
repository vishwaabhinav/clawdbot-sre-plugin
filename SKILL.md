---
name: nomie-sre
description: AI SRE monitoring for Nomie - polls Sentry, PostHog, and CloudWatch
version: 1.0.0
author: abhinav
---

# Nomie SRE

Monitors Nomie infrastructure and reports alerts to Telegram.

## Commands

- `poll` - Run a single poll cycle (normally triggered by cron)
- `status` - Show current monitoring status and last poll time
- `test` - Send a test alert to verify Telegram delivery

## Environment Variables

- `SENTRY_AUTH_TOKEN` - Sentry API auth token
- `SENTRY_ORG` - Sentry organization slug
- `SENTRY_PROJECT` - Sentry project slug
- `POSTHOG_API_KEY` - PostHog personal API key
- `POSTHOG_PROJECT_ID` - PostHog project ID
- `AWS_ACCESS_KEY_ID` - AWS credentials for CloudWatch
- `AWS_SECRET_ACCESS_KEY` - AWS credentials
- `AWS_REGION` - AWS region (us-east-1)
- `TELEGRAM_CHAT_ID` - Telegram group ID for alerts
