import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

const CARE_DIR = join(homedir(), ".claude-care");
const SESSIONS_DIR = join(CARE_DIR, "sessions");

async function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const turns = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "user" && typeof msg.message?.content === "string") {
        turns.push({ role: "user", content: msg.message.content });
      } else if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) turns.push({ role: "assistant", content: text });
      }
    } catch {}
  }
  return turns;
}

function dominantEmotion(scores) {
  if (!scores) return "baseline";
  let top = "baseline";
  let topValue = 0;
  for (const [e, v] of Object.entries(scores)) {
    if (v > topValue && EMOTION_PROTOTYPES[e]) {
      top = e;
      topValue = v;
    }
  }
  return top;
}

function weightedVA(scores) {
  if (!scores) return { valence: 0, arousal: 0 };
  let v = 0, a = 0, total = 0;
  for (const [e, w] of Object.entries(scores)) {
    const proto = EMOTION_PROTOTYPES[e];
    if (!proto || typeof w !== "number") continue;
    v += proto.valence * w;
    a += proto.arousal * w;
    total += w;
  }
  if (total === 0) return { valence: 0, arousal: 0 };
  return { valence: v / total, arousal: a / total };
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "00:00:00";
  }
}

function truncate(text, max) {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}

function mapSessionToPrompts(session, transcriptTurns) {
  if (!session?.turns?.length) return [];
  const userPromptByAssistantOrder = [];
  let pendingUserText = "";
  for (const t of transcriptTurns) {
    if (t.role === "user") {
      pendingUserText = t.content;
    } else if (t.role === "assistant") {
      userPromptByAssistantOrder.push(pendingUserText);
      pendingUserText = "";
    }
  }
  const prompts = [];
  let assistantOrder = 0;
  let n = 1;
  for (const turn of session.turns) {
    if (turn.source !== "assistant") continue;
    const scores = turn.emotion_scores;
    if (!scores) {
      assistantOrder++;
      continue;
    }
    const { valence, arousal } = weightedVA(scores);
    const emotion = dominantEmotion(scores);
    const rawText = userPromptByAssistantOrder[assistantOrder];
    const text = rawText && rawText.trim()
      ? rawText
      : "(continuation — no new user prompt)";
    prompts.push({
      t: formatTime(turn.ts),
      n: String(n).padStart(2, "0"),
      emotion,
      valence,
      arousal,
      text: truncate(text, 220),
      emotion_scores: scores,
    });
    assistantOrder++;
    n++;
  }
  return prompts;
}

export async function GET(_req, { params }) {
  try {
    const { id } = params;
    if (!id) {
      return Response.json({ error: "missing session id", prompts: [] }, { status: 400 });
    }
    const path = join(SESSIONS_DIR, `${id}.json`);
    if (!existsSync(path)) {
      return Response.json(
        { error: "session not found", prompts: [] },
        { status: 404 },
      );
    }
    const raw = await readFile(path, "utf8");
    const session = JSON.parse(raw);
    const transcript = await readTranscript(session.transcript_path);
    const prompts = mapSessionToPrompts(session, transcript);
    return Response.json({
      session_id: session.session_id,
      last_updated: session.last_updated,
      prompts,
    });
  } catch (err) {
    return Response.json(
      { error: String(err?.message ?? err), prompts: [] },
      { status: 500 },
    );
  }
}
