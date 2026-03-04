// Sentry types
export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  shortId: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  platform?: string;
  metadata: {
    type?: string;
    value?: string;
    function?: string;
    filename?: string;
  };
  tags?: Array<{ key: string; value: string }>;
}

export interface SentryEvent {
  id: string;
  message?: string;
  culprit?: string;
  context?: Record<string, any>;
  entries?: Array<{
    type: string;
    data: {
      values?: Array<{
        type: string;
        value: string;
        stacktrace?: {
          frames: Array<{
            filename: string;
            function: string;
            lineNo: number;
            colNo: number;
            context?: Array<[number, string]>;
          }>;
        };
      }>;
    };
  }>;
  tags?: Array<{ key: string; value: string }>;
}

export interface SentryAlert {
  type: "sentry";
  issueId: string;
  shortId: string;
  title: string;
  function: string;
  count: number;
  link: string;
  firstSeen: string;
  lastSeen: string;
  stackTrace?: string;
  filename?: string;
  errorType?: string;
  tags?: Record<string, string>;
}

// PostHog types
export interface PostHogAlert {
  type: "posthog";
  metric: string;
  current: number;
  baseline: number;
  changePercent: number;
}

// CloudWatch types
export interface CloudWatchAlert {
  type: "cloudwatch";
  metric: string;
  resource: string;
  value: number;
  threshold: number;
  details?: string;    // Actual error message from logs
  timestamp?: string;  // When the error occurred
}

// Union type for all alerts
export type Alert = SentryAlert | PostHogAlert | CloudWatchAlert;

// Plugin state
export interface PluginState {
  lastPollTime: string;
  seenSentryIssues: string[];
  silencedUntil: string | null;
  lastAlerts: Alert[];
  lastSummaryDate?: string; // YYYY-MM-DD format
  alertedAnomalies?: string[]; // metric_YYYY-MM-DD keys for deduplication
  pendingDigestAlerts?: Alert[]; // Alerts waiting for next digest
  lastDigestTime?: string; // ISO timestamp of last digest send
}

// Plugin config
export interface NomieSreConfig {
  sentryAuthToken?: string;
  sentryOrg?: string;
  sentryProject?: string;
  posthogApiKey?: string;
  posthogProjectId?: string;
  awsRegion?: string;
  pollIntervalMinutes?: number;
  alertChannel?: string;
  alertChatId?: string;
  // Digest mode - batch alerts and send every X hours instead of immediately
  digestIntervalHours?: number; // e.g. 3 = send digest every 3 hours
  // Auto-fix options
  autoFix?: boolean;
  autoFixRepo?: string;
  autoFixModel?: string;
  autoFixTimeoutSeconds?: number;
}
