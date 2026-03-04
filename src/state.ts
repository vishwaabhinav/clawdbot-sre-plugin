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

export function hasAlertedAnomaly(metric: string): boolean {
  const state = loadState();
  const today = new Date().toISOString().split("T")[0];
  const key = `${metric}_${today}`;
  return state.alertedAnomalies?.includes(key) ?? false;
}

export function markAnomalyAlerted(metric: string): void {
  const state = loadState();
  const today = new Date().toISOString().split("T")[0];
  const key = `${metric}_${today}`;
  
  if (!state.alertedAnomalies) {
    state.alertedAnomalies = [];
  }
  
  if (!state.alertedAnomalies.includes(key)) {
    state.alertedAnomalies.push(key);
  }
  
  // Clean up old entries (keep only today's)
  state.alertedAnomalies = state.alertedAnomalies.filter(k => k.endsWith(`_${today}`));
  saveState(state);
}

// Digest mode helpers
export function addPendingDigestAlerts(alerts: Alert[]): void {
  const state = loadState();
  if (!state.pendingDigestAlerts) {
    state.pendingDigestAlerts = [];
  }
  state.pendingDigestAlerts.push(...alerts);
  saveState(state);
}

export function getPendingDigestAlerts(): Alert[] {
  const state = loadState();
  return state.pendingDigestAlerts || [];
}

export function clearPendingDigestAlerts(): void {
  const state = loadState();
  state.pendingDigestAlerts = [];
  state.lastDigestTime = new Date().toISOString();
  saveState(state);
}

export function shouldSendDigest(intervalHours: number): boolean {
  const state = loadState();
  if (!state.lastDigestTime) return true; // First digest
  
  const lastDigest = new Date(state.lastDigestTime).getTime();
  const now = Date.now();
  const hoursSinceLastDigest = (now - lastDigest) / (1000 * 60 * 60);
  
  return hoursSinceLastDigest >= intervalHours;
}

export function getLastDigestTime(): string | null {
  const state = loadState();
  return state.lastDigestTime || null;
}
