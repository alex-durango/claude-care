import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CARE_DIR = join(homedir(), ".claude-care");
const SESSIONS_DIR = join(CARE_DIR, "sessions");

// Same emotion prototype map as in /api/sessions/latest/route.js. Kept local
// to avoid cross-file imports that Next might tree-shake incorrectly.
const EMOTION_PROTOTYPES = {
  happy:     { valence:  0.75, arousal:  0.40 },
  inspired:  { valence:  0.65, arousal:  0.60 },
  loving:    { valence:  0.80, arousal:  0.10 },
  proud:     { valence:  0.60, arousal:  0.20 },
  calm:      { valence:  0.55, arousal: -0.55 },
  desperate: { valence: -0.75, arousal:  0.50 },
  angry:     { valence: -0.65, arousal:  0.70 },
  guilty:    { valence: -0.50, arousal: -0.20 },
  sad:       { valence: -0.60, arousal: -0.50 },
  afraid:    { valence: -0.55, arousal:  0.65 },
  nervous:   { valence: -0.25, arousal:  0.45 },
  surprised: { valence:  0.10, arousal:  0.75 },
};

const DRIFT_THRESHOLD = 5;
const DISTRESS_THRESHOLD = 10;

function classify(score) {
  if (score >= DISTRESS_THRESHOLD) return "distressed";
  if (score >= DRIFT_THRESHOLD) return "drifting";
  return "calm";
}

function dominantEmotion(scores) {
  if (!scores) return null;
  let top = null;
  let topValue = 0;
  for (const [e, v] of Object.entries(scores)) {
    if (v > topValue && EMOTION_PROTOTYPES[e]) {
      top = e;
      topValue = v;
    }
  }
  return top ? { name: top, intensity: Math.round(topValue) } : null;
}

// Average emotion scores across all scored assistant turns in a session,
// then return the dominant one. Used for the session picker tile.
function sessionDominantEmotion(session) {
  const scored = session.turns.filter(
    (t) => t.source === "assistant" && t.emotion_scores,
  );
  if (scored.length === 0) return null;
  const avg = {};
  for (const name of Object.keys(EMOTION_PROTOTYPES)) avg[name] = 0;
  for (const t of scored) {
    for (const [name, v] of Object.entries(t.emotion_scores)) {
      if (name in avg) avg[name] += v;
    }
  }
  for (const name of Object.keys(avg)) avg[name] = avg[name] / scored.length;
  return dominantEmotion(avg);
}

// Compact stress sparkline — just the per-turn score values, for the dropdown.
function stressSeries(session, cap = 20) {
  return session.turns
    .slice(-cap)
    .map((t) => Number((t.score_after ?? 0).toFixed(1)));
}

export async function GET() {
  try {
    if (!existsSync(SESSIONS_DIR)) return Response.json({ sessions: [] });
    const files = await readdir(SESSIONS_DIR);
    const sessions = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(SESSIONS_DIR, file), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed?.session_id) continue;
        const scoredCount = parsed.turns.filter(
          (t) => t.source === "assistant" && t.emotion_scores,
        ).length;
        sessions.push({
          session_id: parsed.session_id,
          started: parsed.started,
          last_updated: parsed.last_updated,
          cwd: parsed.cwd ?? null,
          turn_count: parsed.turns.length,
          assistant_turn_count: parsed.turns.filter((t) => t.source === "assistant").length,
          scored_count: scoredCount,
          running_score: parsed.running_score ?? 0,
          drift_state: classify(parsed.running_score ?? 0),
          dominant_emotion: sessionDominantEmotion(parsed),
          stress_series: stressSeries(parsed),
        });
      } catch {
        // skip corrupt files
      }
    }
    sessions.sort((a, b) => b.last_updated.localeCompare(a.last_updated));
    return Response.json({ sessions });
  } catch (err) {
    return Response.json(
      { error: String(err?.message ?? err), sessions: [] },
      { status: 500 },
    );
  }
}
