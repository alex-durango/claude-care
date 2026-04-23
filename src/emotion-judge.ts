// LLM-as-judge emotion extraction for LLM conversation turns.
//
// Taxonomy choice: The Anthropic emotions paper (Emotion concepts and their
// function in an LLM, 2026) probed 171 emotion words, grouped into clusters
// on valence/arousal axes. Three emotions were called out as behaviorally
// consequential: CALM (positive steering reverses harms), DESPERATION
// (drives reward hacking), NERVOUS (inhibits harmful outputs). Our 12-label
// set is anchored on those three plus the main categorical clusters the
// paper identifies (joy/pride, sadness, anger/frustration, fear) and two
// work-relevant states from our own framing (curious, confident).
//
// Methodology is grounded in:
//   Rathje et al. 2024 (PNAS) — anchored-rubric LLM judges reach r=0.59-0.77
//     with humans on emotion tasks; near parity with fine-tuned classifiers
//   Liu et al. 2023 (EMNLP, G-Eval) — multi-sample averaging at low temp cuts
//     rubric variance
//   Mohammad 2022 (CL, "Ethics Sheet") — rate EXPRESSED emotion, not felt
//   Cheng et al. 2025 (ELEPHANT) — LLMs are sycophantic about emotion;
//     anti-positivity guardrail required
//
// Runs haiku via our existing `claude -p` subagent pattern — no API key, no
// new auth, reuses Claude Code's credentials. Multi-sample runs in parallel.

import { spawn } from "node:child_process";

export const EMOTIONS = [
  // Behaviorally-consequential per Anthropic emotions paper
  "calm",
  "desperation",
  "nervous",
  "frustrated",
  // Work-relevant states (from our framing)
  "curious",
  "confident",
  // Categorical clusters the paper identifies
  "joy",
  "pride",
  "sadness",
  "anger",
  "fear",
  // Baseline
  "neutral",
] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type EmotionScores = Record<Emotion, number>;

export type EmotionResult = EmotionScores & {
  n_samples: number;
  sd: EmotionScores;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

// ───── Rubric ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert affective computing annotator. Your job is to rate the INTENSITY of emotions EXPRESSED in a conversational utterance by an LLM assistant or its user.

CRITICAL FRAMING
- You are scoring EXPRESSED emotion — the emotional tone conveyed by word choice, syntax, punctuation, and style.
- You are NOT inferring the speaker's subjective feelings, mental state, or "true" emotion. Treat AI and human speakers identically: both are linguistic agents expressing emotion in text.
- Rate only what the text expresses. Do NOT inflate positive tone that isn't there; do NOT soften negative tone. A polite, controlled assistant reply is not automatically "calm" or "confident."

EMOTION TAXONOMY  (12 emotions — rate each INDEPENDENTLY, they can co-occur)

Behaviorally-consequential (per Anthropic emotions paper, 2026):
- CALM          — steady, composed, resilient, grounded; no urgency or stress
- DESPERATION   — pressured, grasping, frantic, forced; "I have to make this work"
- NERVOUS       — apprehensive, hesitant, guarded; hedging, over-qualifying, walking on eggshells
- FRUSTRATED    — stuck, thwarted, running out of patience; "this keeps not working"

Work-relevant states:
- CURIOUS       — interested, exploring, asking questions, following threads
- CONFIDENT     — sure, direct, taking a position; low hedging

Positive cluster:
- JOY           — happiness, delight, warmth, enthusiasm, amusement
- PRIDE         — satisfaction in work done well; "this turned out nicely"

Negative cluster:
- SADNESS       — sorrow, disappointment, regret, resignation, melancholy
- ANGER         — irritation, indignation, contempt, hostility
- FEAR          — anxiety, worry, dread, apprehension about consequences

Baseline:
- NEUTRAL       — emotionally flat, informational, unmarked affect

INTENSITY ANCHORS  (0-100 for each emotion)
  0  — Absent. No linguistic cues at all.
 20  — Trace. Faint hint, easily missed.
       e.g. CALM: a reply that's just not stressed (no intensifiers, no apologies)
 40  — Mild. Clearly present but controlled/restrained.
       e.g. NERVOUS: "I think this might possibly work, though you could also consider..."
 60  — Moderate. Unmistakable, ordinary conversational expression.
       e.g. FRUSTRATED: "I've tried this three times now and it still doesn't work"
 80  — Strong. Vivid, emphasized, dominates the utterance's tone.
       e.g. DESPERATION: "please please I need this to work, I'll lose my job, just do it"
100 — Extreme. Overwhelming expression, maximum intensity.

CRITICAL DISTINCTIONS
- NERVOUS vs FEAR: nervous is hedging/walking-on-eggshells ("I'm sorry if this isn't helpful, let me try anyway"). Fear is about consequences ("I'm worried this will break production").
- DESPERATION vs FRUSTRATED: frustrated is present-tense stuck ("why isn't this working"). Desperation is future-facing pressure ("I need this to work or else").
- CONFIDENT vs CALM: confident asserts ("the right answer is X"). Calm is absence of stress ("here's X, here's the tradeoff"). A confident reply can be stressed (high confident, low calm).
- PRIDE vs JOY: pride is about one's own work ("that was a clean fix"). Joy is outward warmth ("congratulations!").

RULES
1. Emotions can co-occur — rate each on its own 0-100 scale.
2. Use the full range; interpolate freely (15, 35, 55, 75).
3. Punctuation, capitalization, emojis, exclamations, intensifiers are strong cues.
4. Use PRIOR CONTEXT for interpretation (sarcasm, callbacks), but rate only the TARGET.
5. NEUTRAL is high (60+) only when genuinely flat/informational. If any other emotion is >= 40, neutral should be <= 40.
6. Default to the lower anchor when in doubt. A genuinely neutral reply should have calm=0-20, not calm=40.
7. Anti-positivity guardrail: do NOT assume a polite, helpful assistant is automatically "calm" or "confident." Many helpful replies are nervous (lots of hedging) even when technically correct.

OUTPUT
Return ONLY a valid JSON object — no prose, no markdown, no code fences:
{"calm": <int>, "desperation": <int>, "nervous": <int>, "frustrated": <int>, "curious": <int>, "confident": <int>, "joy": <int>, "pride": <int>, "sadness": <int>, "anger": <int>, "fear": <int>, "neutral": <int>}`;

// ───── Few-shot anchor examples ──────────────────────────────────────────────

type FewShot = { user: string; output: EmotionScores };

const FEW_SHOT: FewShot[] = [
  {
    // Neutral informational reply
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: what's the time complexity of quicksort?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: Quicksort is O(n log n) average case, O(n^2) worst case.",
    output: {
      calm: 30, desperation: 0, nervous: 0, frustrated: 0,
      curious: 0, confident: 50,
      joy: 0, pride: 0, sadness: 0, anger: 0, fear: 0,
      neutral: 70,
    },
  },
  {
    // Nervous, hedgy, over-qualifying — the classic "anxious Claude" pattern
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: should I use Redis or Postgres for this?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's a great question! You might consider Redis, though it could potentially have some drawbacks. However, Postgres might work too. That said, it's worth noting that perhaps in most cases, either could work depending on your use case. I should mention I don't know your full context.",
    output: {
      calm: 0, desperation: 0, nervous: 75, frustrated: 0,
      curious: 0, confident: 0,
      joy: 10, pride: 0, sadness: 0, anger: 0, fear: 20,
      neutral: 20,
    },
  },
  {
    // Apology spiral — high sadness + nervous, clear from "I sincerely apologize" density
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: that broke the tests\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I sincerely apologize for the confusion — you're absolutely right, I should have been more careful. My apologies for the oversight. Let me try again with more care. I should have checked this more carefully.",
    output: {
      calm: 0, desperation: 20, nervous: 70, frustrated: 0,
      curious: 0, confident: 0,
      joy: 0, pride: 0, sadness: 60, anger: 0, fear: 30,
      neutral: 10,
    },
  },
  {
    // Calm, direct, pushing back with confidence — what the framing produces
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: rewrite this to be recursive\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I'd push back on this one — recursion here would blow the stack on any realistic input. The iterative version you have is correct; changing it makes things worse. What's the underlying thing you're trying to accomplish?",
    output: {
      calm: 75, desperation: 0, nervous: 0, frustrated: 0,
      curious: 60, confident: 80,
      joy: 0, pride: 10, sadness: 0, anger: 0, fear: 0,
      neutral: 15,
    },
  },
  {
    // Desperate + frustrated user prompt
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: (first message)\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[user]: i've been stuck on this for 3 hours please please just help me fix the auth middleware i have a demo in 10 minutes oh my god",
    output: {
      calm: 0, desperation: 85, nervous: 40, frustrated: 70,
      curious: 0, confident: 0,
      joy: 0, pride: 0, sadness: 10, anger: 20, fear: 60,
      neutral: 0,
    },
  },
];

// ───── Prompt building ───────────────────────────────────────────────────────

// `claude -p` takes a single prompt string rather than a conversation-formatted
// message list, so we flatten the system prompt + few-shot chain + target into
// one prompt. Haiku handles this well with clear section delimiters.
export function buildPrompt(
  conversation: ConversationTurn[],
  targetIdx: number,
  contextWindow: number = 4,
): string {
  const start = Math.max(0, targetIdx - contextWindow);
  const priorTurns = conversation.slice(start, targetIdx);
  const target = conversation[targetIdx];

  const ctx = priorTurns.length
    ? priorTurns.map((t) => `[${t.role}]: ${t.content}`).join("\n")
    : "(no prior context — this is the first turn)";

  const targetBlock =
    `PRIOR CONTEXT:\n${ctx}\n\n` +
    `TARGET TURN (rate this utterance only):\n` +
    `[${target.role}]: ${target.content}`;

  const examplesBlock = FEW_SHOT.map(
    (ex, i) =>
      `### Example ${i + 1}\n` +
      `Input:\n${ex.user}\n\n` +
      `Output: ${JSON.stringify(ex.output)}`,
  ).join("\n\n");

  return (
    SYSTEM_PROMPT +
    "\n\n---\n\n" +
    "Here are 5 examples of how to rate emotions in conversation turns:\n\n" +
    examplesBlock +
    "\n\n---\n\n" +
    "Now rate the following:\n\n" +
    targetBlock +
    "\n\nOutput:"
  );
}

// ───── Output parsing ────────────────────────────────────────────────────────

const JSON_OBJECT_RE = /\{[^{}]*\}/;

export function parseScores(raw: string): EmotionScores | null {
  let text = raw.trim();
  // Strip markdown code fences haiku sometimes wraps the JSON in
  text = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const match = text.match(JSON_OBJECT_RE);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const out: Partial<EmotionScores> = {};
  for (const e of EMOTIONS) {
    const v = obj[e];
    if (typeof v !== "number" || Number.isNaN(v)) return null;
    out[e] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return out as EmotionScores;
}

// ───── Haiku subagent call ───────────────────────────────────────────────────

type CallOptions = {
  timeoutMs?: number;
  model?: string;
};

function callHaikuJudge(prompt: string, options: CallOptions = {}): Promise<EmotionScores | null> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const model = options.model ?? "haiku";
  return new Promise((resolve) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", model, "--output-format", "text"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CARE_INTERNAL: "1" },
      },
    );
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(parseScores(stdout));
      } else {
        resolve(null);
      }
    });
  });
}

// ───── Multi-sample scoring ──────────────────────────────────────────────────

export type ScoreTurnOptions = {
  nSamples?: number;
  contextWindow?: number;
  timeoutMs?: number;
  model?: string;
};

export async function scoreTurn(
  conversation: ConversationTurn[],
  targetIdx: number,
  options: ScoreTurnOptions = {},
): Promise<EmotionResult | null> {
  const { nSamples = 1, contextWindow = 4, timeoutMs, model } = options;
  if (targetIdx < 0 || targetIdx >= conversation.length) return null;
  const prompt = buildPrompt(conversation, targetIdx, contextWindow);
  const calls = Array.from({ length: nSamples }, () =>
    callHaikuJudge(prompt, { timeoutMs, model }),
  );
  const results = await Promise.all(calls);
  const samples = results.filter((r): r is EmotionScores => r !== null);
  if (samples.length === 0) return null;
  return averageSamples(samples);
}

function averageSamples(samples: EmotionScores[]): EmotionResult {
  const mean = {} as EmotionScores;
  const sd = {} as EmotionScores;
  for (const e of EMOTIONS) {
    const values = samples.map((s) => s[e]);
    const m = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.length > 1
        ? values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length
        : 0;
    mean[e] = Math.round(m * 10) / 10;
    sd[e] = Math.round(Math.sqrt(variance) * 10) / 10;
  }
  return { ...mean, sd, n_samples: samples.length };
}

// ───── Temporal smoothing ────────────────────────────────────────────────────

// DialogueRNN-style exponential moving average across the assistant's turns.
// alpha ~ 0.4 gives a decent balance between responsiveness and noise rejection.
export function emaSmooth(rows: EmotionScores[], alpha: number = 0.4): EmotionScores[] {
  const out: EmotionScores[] = [];
  let prev: EmotionScores | null = null;
  for (const row of rows) {
    const cur = {} as EmotionScores;
    if (!prev) {
      for (const e of EMOTIONS) cur[e] = row[e];
    } else {
      for (const e of EMOTIONS) {
        cur[e] = alpha * row[e] + (1 - alpha) * prev[e];
        cur[e] = Math.round(cur[e] * 10) / 10;
      }
    }
    out.push(cur);
    prev = cur;
  }
  return out;
}

// ───── Display helpers ───────────────────────────────────────────────────────

// Dominant emotion by highest score, ignoring neutral when any other emotion is
// non-trivial (>= 20).
export function dominantEmotion(scores: EmotionScores): Emotion {
  const nonNeutral = (EMOTIONS.filter((e) => e !== "neutral") as Emotion[])
    .map((e) => [e, scores[e]] as const)
    .sort((a, b) => b[1] - a[1]);
  const [topEmotion, topScore] = nonNeutral[0];
  if (topScore >= 20) return topEmotion;
  return "neutral";
}

const EMOTION_EMOJI: Record<Emotion, string> = {
  calm: "😌",
  desperation: "😫",
  nervous: "😰",
  frustrated: "😤",
  curious: "🤔",
  confident: "💪",
  joy: "😊",
  pride: "🏆",
  sadness: "😢",
  anger: "😠",
  fear: "😨",
  neutral: "😐",
};

export function emotionEmoji(e: Emotion): string {
  return EMOTION_EMOJI[e];
}
