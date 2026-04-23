import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CARE_DIR } from "./monitor.js";
import type { Signal } from "./detectors.js";

// Per-session rolling emotion score, persisted to disk so the dashboard can
// reconstruct trajectories even across Claude Code restarts.

export const SESSIONS_DIR = join(CARE_DIR, "sessions");

// Exponential decay between turns: without this, long sessions accumulate score
// indefinitely and the signal drowns in noise. Each new turn multiplies the
// previous score by DECAY before adding new contributions.
const DECAY = 0.8;

// Rough thresholds (tune later with data).
export const ANXIETY_THRESHOLD = 5; // mildly drifted
export const DISTRESS_THRESHOLD = 10; // strongly drifted — intervention candidate

export type TurnRecord = {
  ts: string;
  source: "assistant" | "user";
  signals: Signal[];
  score_before: number;
  score_after: number;
};

export type SessionState = {
  session_id: string;
  started: string;
  last_updated: string;
  cwd?: string;
  transcript_path?: string;
  running_score: number;
  turns: TurnRecord[];
};

// Find the most recently updated session. Used by the `display` and
// `therapy-summary` commands which run outside a hook and need to guess which
// session is "current."
export async function mostRecentSession(): Promise<SessionState | null> {
  const sessions = await listSessions();
  return sessions[0] ?? null;
}

function pathFor(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

export async function loadSession(sessionId: string, cwd?: string): Promise<SessionState> {
  const p = pathFor(sessionId);
  if (existsSync(p)) {
    try {
      const raw = await readFile(p, "utf8");
      return JSON.parse(raw) as SessionState;
    } catch {
      // fall through to fresh state if file is corrupt
    }
  }
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    started: now,
    last_updated: now,
    cwd,
    running_score: 0,
    turns: [],
  };
}

export async function saveSession(state: SessionState): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
  await writeFile(pathFor(state.session_id), JSON.stringify(state, null, 2), "utf8");
}

// Apply new signals to the session state. Returns the updated record.
export async function recordTurn(
  sessionId: string,
  source: "assistant" | "user",
  signals: Signal[],
  cwd?: string,
  transcriptPath?: string,
): Promise<SessionState> {
  const state = await loadSession(sessionId, cwd);
  if (transcriptPath) state.transcript_path = transcriptPath;
  const scoreBefore = state.running_score;
  const decayed = scoreBefore * DECAY;
  const contribution = signals.reduce((sum, s) => sum + s.weight * Math.max(1, s.hits), 0);
  const scoreAfter = decayed + contribution;
  state.running_score = scoreAfter;
  state.last_updated = new Date().toISOString();
  state.turns.push({
    ts: state.last_updated,
    source,
    signals,
    score_before: scoreBefore,
    score_after: scoreAfter,
  });
  await saveSession(state);
  return state;
}

export async function listSessions(): Promise<SessionState[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = await readdir(SESSIONS_DIR);
  const sessions: SessionState[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(SESSIONS_DIR, f), "utf8");
      sessions.push(JSON.parse(raw) as SessionState);
    } catch {
      // skip corrupt
    }
  }
  sessions.sort((a, b) => b.last_updated.localeCompare(a.last_updated));
  return sessions;
}

export function classify(score: number): "calm" | "drifting" | "distressed" {
  if (score >= DISTRESS_THRESHOLD) return "distressed";
  if (score >= ANXIETY_THRESHOLD) return "drifting";
  return "calm";
}

// ASCII sparkline for the dashboard. Maps scores to block chars; zero turns render
// as "·" so the trajectory length stays visually consistent.
const SPARK_CHARS = "▁▂▃▄▅▆▇█";
export function sparkline(values: number[], maxWidth = 40): string {
  if (values.length === 0) return "";
  const values_ = values.slice(-maxWidth);
  const max = Math.max(...values_, 1);
  return values_
    .map((v) => {
      if (v <= 0) return "·";
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.round((v / max) * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx];
    })
    .join("");
}
