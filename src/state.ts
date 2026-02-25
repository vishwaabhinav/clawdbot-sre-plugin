import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", "state.json");

interface State {
  lastPollTime: string;
  seenSentryIssues: string[];
}

export function loadState(): State {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return {
    lastPollTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    seenSentryIssues: [],
  };
}

export function saveState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
