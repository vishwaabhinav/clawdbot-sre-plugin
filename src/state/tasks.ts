import { db } from "./db.js";

export type TaskState =
  | "pending"
  | "investigating"
  | "pr_open"
  | "merged"
  | "rejected"
  | "failed";

export interface Task {
  sentry_id: string;
  short_id: string;
  state: TaskState;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  root_cause: string | null;
  fix_summary: string | null;
  files_changed: string | null;
  error_title: string | null;
  error_function: string | null;
  error_count: number | null;
  stack_trace: string | null;
  sentry_link: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export function getTask(sentryId: string): Task | null {
  return db.prepare("SELECT * FROM tasks WHERE sentry_id = ?").get(sentryId) as Task | null;
}

export function getTaskByPR(prNumber: number): Task | null {
  return db.prepare("SELECT * FROM tasks WHERE pr_number = ?").get(prNumber) as Task | null;
}

export function createTask(
  sentryId: string,
  shortId: string,
  errorInfo: {
    title: string;
    function: string;
    count: number;
    stackTrace?: string;
    link?: string;
  }
): Task {
  const existing = getTask(sentryId);
  
  if (existing) {
    // Increment attempts and reset to investigating
    const stmt = db.prepare(`
      UPDATE tasks SET
        state = 'investigating',
        attempts = attempts + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE sentry_id = ?
      RETURNING *
    `);
    return stmt.get(sentryId) as Task;
  }

  const stmt = db.prepare(`
    INSERT INTO tasks (
      sentry_id, short_id, state, error_title, error_function, 
      error_count, stack_trace, sentry_link, attempts
    )
    VALUES (?, ?, 'investigating', ?, ?, ?, ?, ?, 1)
    RETURNING *
  `);
  return stmt.get(
    sentryId,
    shortId,
    errorInfo.title,
    errorInfo.function,
    errorInfo.count,
    errorInfo.stackTrace || null,
    errorInfo.link || null
  ) as Task;
}

export function updateTask(sentryId: string, updates: Partial<Omit<Task, "sentry_id">>): Task | null {
  const allowedFields = [
    "state", "branch", "pr_number", "pr_url", "root_cause",
    "fix_summary", "files_changed", "error_title", "error_function",
    "error_count", "stack_trace", "sentry_link", "attempts"
  ];

  const fieldsToUpdate = Object.keys(updates).filter(k => allowedFields.includes(k));
  if (fieldsToUpdate.length === 0) return getTask(sentryId);

  const setClause = fieldsToUpdate.map(k => `${k} = @${k}`).join(", ");

  const stmt = db.prepare(`
    UPDATE tasks
    SET ${setClause}, updated_at = CURRENT_TIMESTAMP
    WHERE sentry_id = @sentry_id
    RETURNING *
  `);
  return stmt.get({ ...updates, sentry_id: sentryId }) as Task | null;
}

export function getStaleInvestigating(timeoutMinutes: number = 15): Task[] {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE state = 'investigating'
    AND datetime(updated_at) < datetime('now', '-' || ? || ' minutes')
  `).all(timeoutMinutes) as Task[];
}

export function getAllOpenTasks(): Task[] {
  return db.prepare(`
    SELECT * FROM tasks 
    WHERE state IN ('pending', 'investigating', 'pr_open')
    ORDER BY updated_at DESC
  `).all() as Task[];
}
