import { Database } from "bun:sqlite";

// Use absolute path to ensure consistent location regardless of where code runs from
const DB_PATH = "/home/clawdbot/clawd/skills/nomie-sre/tasks.db";

export const db = new Database(DB_PATH);

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    sentry_id TEXT PRIMARY KEY,
    short_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    branch TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    root_cause TEXT,
    fix_summary TEXT,
    files_changed TEXT,
    error_title TEXT,
    error_function TEXT,
    error_count INTEGER,
    stack_trace TEXT,
    sentry_link TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
  CREATE INDEX IF NOT EXISTS idx_tasks_short_id ON tasks(short_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_pr_number ON tasks(pr_number);
`);
