import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PluginState, Alert } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(STATE_DIR, "state.json");

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function loadState(): PluginState {
  ensureStateDir();
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    } catch {
      // Return default state on parse error
    }
  }
  return {
    lastPollTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    seenSentryIssues: [],
    silencedUntil: null,
    lastAlerts: [],
  };
}

export function saveState(state: PluginState): void {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function isSilenced(state: PluginState): boolean {
  if (!state.silencedUntil) return false;
  return new Date(state.silencedUntil) > new Date();
}

export function silenceAlerts(minutes: number): PluginState {
  const state = loadState();
  state.silencedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  saveState(state);
  return state;
}

export function unsilenceAlerts(): PluginState {
  const state = loadState();
  state.silencedUntil = null;
  saveState(state);
  return state;
}

export function updateLastAlerts(alerts: Alert[]): void {
  const state = loadState();
  state.lastAlerts = alerts;
  state.lastPollTime = new Date().toISOString();
  saveState(state);
}

export function addSeenSentryIssues(issueIds: string[]): void {
  const state = loadState();
  const seen = new Set(state.seenSentryIssues);
  for (const id of issueIds) {
    seen.add(id);
  }
  // Keep only last 1000 issues to prevent unbounded growth
  state.seenSentryIssues = Array.from(seen).slice(-1000);
  saveState(state);
}

export function shouldSendDailySummary(): boolean {
  const state = loadState();
  const today = new Date().toISOString().split("T")[0];
  return state.lastSummaryDate !== today;
}

export function markSummarySent(): void {
  const state = loadState();
  state.lastSummaryDate = new Date().toISOString().split("T")[0];
  saveState(state);
}
