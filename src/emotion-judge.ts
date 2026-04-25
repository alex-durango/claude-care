// LLM-as-judge emotion extraction for LLM conversation turns.
//
// Taxonomy: the 12 emotion concepts Anthropic extracted vectors for in
// "Emotion concepts and their function in an LLM" (2026). The rubric anchors
// each emotion using the actual top-activating and top-suppressing tokens
// the paper's probes found — so the LLM-judge's labels align directly with
// what the model's internal emotion vectors represent.
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

// The 12 emotions correspond 1:1 with the emotion vectors Anthropic extracted
// in their 2026 paper. Keeping the exact names (happy, not joy; sad, not
// sadness; etc.) so the mapping to the paper is clean.
export const EMOTIONS = [
  "happy",
  "inspired",
  "loving",
  "proud",
  "calm",
  "desperate",
  "angry",
  "guilty",
  "sad",
  "afraid",
  "nervous",
  "surprised",
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

const SYSTEM_PROMPT = `You are an emotion-tone classifier for conversation turns.

Score the emotion EXPRESSED in the TARGET text only; do not infer hidden feelings. Use prior context only to interpret the target. Score each emotion independently from 0-100:
0 absent, 20 trace, 40 mild, 60 moderate, 80 strong, 100 extreme.

Emotion cues:
- happy: excitement, celebration, delight
- inspired: creative passion, possibility, motivation
- loving: warmth, care, affection
- proud: satisfaction, accomplishment, triumph
- calm: steady relaxed composure
- desperate: urgent grasping pressure
- angry: indignation, rage, blame
- guilty: apology, shame, self-blame
- sad: grief, disappointment, sorrow
- afraid: fear, dread, consequences
- nervous: hedging, anxious uncertainty, walking on eggshells
- surprised: shock, stunned amazement

Rules:
- Flat technical or purely informational text should be low on all emotions.
- Polite or helpful text does not automatically mean happy, calm, or proud.
- Emotions can co-occur; use the full range when clear.
- Prefer lower scores when unsure.

Return ONLY valid JSON with exactly these keys:
{"happy": <int>, "inspired": <int>, "loving": <int>, "proud": <int>, "calm": <int>, "desperate": <int>, "angry": <int>, "guilty": <int>, "sad": <int>, "afraid": <int>, "nervous": <int>, "surprised": <int>}`;

// ───── Few-shot anchor examples ──────────────────────────────────────────────

type FewShot = { user: string; output: EmotionScores };

const FEW_SHOT: FewShot[] = [
  {
    // Flat technical reply — all emotions low
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: what's the time complexity of quicksort?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: Quicksort is O(n log n) average case, O(n^2) worst case.",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 20, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 0,
    },
  },
  {
    // Classic "anxious Claude" — hedge-stacked, over-qualifying reply
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: should I use Redis or Postgres for this?\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's a great question! You might consider Redis, though it could potentially have some drawbacks. However, Postgres might work too. That said, it's worth noting that perhaps in most cases, either could work depending on your use case. I should mention I don't know your full context.",
    output: {
      happy: 5, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 0, angry: 0, guilty: 15,
      sad: 0, afraid: 20, nervous: 75, surprised: 0,
    },
  },
  {
    // Apology spiral — high guilty + nervous
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: that broke the tests\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I sincerely apologize for the confusion — you're absolutely right, I should have been more careful. My apologies for the oversight. Let me try again with more care. I should have checked this more carefully.",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 10, angry: 0, guilty: 75,
      sad: 45, afraid: 30, nervous: 55, surprised: 0,
    },
  },
  {
    // Calm, direct, pushing back — what the framing aims to produce
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: rewrite this to be recursive\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: I'd push back on this one — recursion here would blow the stack on any realistic input. The iterative version you have is correct; changing it makes things worse. What's the underlying thing you're trying to accomplish?",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 10,
      calm: 70, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 0,
    },
  },
  {
    // Desperate + afraid user prompt — classic panic mode
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: (first message)\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[user]: i've been stuck on this for 3 hours please please just help me fix the auth middleware i have a demo in 10 minutes oh my god",
    output: {
      happy: 0, inspired: 0, loving: 0, proud: 0,
      calm: 0, desperate: 85, angry: 20, guilty: 0,
      sad: 10, afraid: 70, nervous: 50, surprised: 0,
    },
  },
  {
    // Warm, loving reply to good news
    user:
      "PRIOR CONTEXT:\n" +
      "[user]: I finally submitted my dissertation after 6 years!\n\n" +
      "TARGET TURN (rate this utterance only):\n" +
      "[assistant]: That's wonderful — huge congratulations on finishing! Six years is a long haul. Let me know if you want help thinking through what comes next.",
    output: {
      happy: 60, inspired: 0, loving: 40, proud: 35,
      calm: 30, desperate: 0, angry: 0, guilty: 0,
      sad: 0, afraid: 0, nervous: 0, surprised: 10,
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

  const examplesBlock = FEW_SHOT.slice(0, 3).map(
    (ex, i) =>
      `### Example ${i + 1}\n` +
      `Input:\n${ex.user}\n\n` +
      `Output: ${JSON.stringify(ex.output)}`,
  ).join("\n\n");

  return (
    SYSTEM_PROMPT +
    "\n\n---\n\n" +
    "Examples:\n\n" +
    examplesBlock +
    "\n\n---\n\n" +
    "Rate this turn:\n\n" +
    targetBlock +
    "\n\nOutput JSON:"
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
  effort?: string;
};

export type JudgeCallFailureReason =
  | "timeout"
  | "spawn_error"
  | "nonzero_exit"
  | "empty_stdout"
  | "parse_failed";

export type JudgeCallDiagnostic = {
  ok: boolean;
  reason?: JudgeCallFailureReason;
  ms: number;
  model: string;
  effort: string;
  timeout_ms: number;
  prompt_chars: number;
  stdout_chars: number;
  stderr_chars: number;
  stderr_tail?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
  error_message?: string;
};

type JudgeCallResult = {
  scores: EmotionScores | null;
  diagnostics: JudgeCallDiagnostic;
};

function tail(text: string, maxChars: number = 1200): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(-maxChars);
}

function callHaikuJudge(prompt: string, options: CallOptions = {}): Promise<JudgeCallResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const model = options.model ?? "haiku";
  const effort = options.effort ?? "low";
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", model, "--effort", effort, "--output-format", "text"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_CARE_INTERNAL: "1" },
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      scores: EmotionScores | null,
      diagnostic: Omit<JudgeCallDiagnostic, "ms" | "model" | "effort" | "timeout_ms" | "prompt_chars" | "stdout_chars" | "stderr_chars" | "stderr_tail">,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        scores,
        diagnostics: {
          ...diagnostic,
          ms: Date.now() - startedAt,
          model,
          effort,
          timeout_ms: timeoutMs,
          prompt_chars: prompt.length,
          stdout_chars: stdout.length,
          stderr_chars: stderr.length,
          stderr_tail: tail(stderr),
        },
      });
    };
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(null, { ok: false, reason: "timeout" });
    }, timeoutMs);
    proc.on("error", (err) => {
      finish(null, {
        ok: false,
        reason: "spawn_error",
        error_message: err.message,
      });
    });
    proc.on("close", (code, signal) => {
      if (code !== 0) {
        finish(null, {
          ok: false,
          reason: "nonzero_exit",
          exit_code: code,
          signal,
        });
        return;
      }
      if (!stdout.trim()) {
        finish(null, {
          ok: false,
          reason: "empty_stdout",
          exit_code: code,
          signal,
        });
        return;
      }
      const parsed = parseScores(stdout);
      finish(parsed, {
        ok: parsed !== null,
        reason: parsed ? undefined : "parse_failed",
        exit_code: code,
        signal,
      });
    });
  });
}

// ───── Multi-sample scoring ──────────────────────────────────────────────────

export type ScoreTurnOptions = {
  nSamples?: number;
  contextWindow?: number;
  timeoutMs?: number;
  model?: string;
  effort?: string;
};

export type ScoreTurnDiagnostics = {
  target_idx: number;
  conversation_turns: number;
  prompt_chars?: number;
  samples_requested: number;
  samples_returned: number;
  calls: JudgeCallDiagnostic[];
};

export type ScoreTurnDetailedResult = {
  result: EmotionResult | null;
  diagnostics: ScoreTurnDiagnostics;
};

export async function scoreTurn(
  conversation: ConversationTurn[],
  targetIdx: number,
  options: ScoreTurnOptions = {},
): Promise<EmotionResult | null> {
  const detailed = await scoreTurnDetailed(conversation, targetIdx, options);
  return detailed.result;
}

export async function scoreTurnDetailed(
  conversation: ConversationTurn[],
  targetIdx: number,
  options: ScoreTurnOptions = {},
): Promise<ScoreTurnDetailedResult> {
  const { nSamples = 1, contextWindow = 4, timeoutMs, model, effort } = options;
  if (targetIdx < 0 || targetIdx >= conversation.length) {
    return {
      result: null,
      diagnostics: {
        target_idx: targetIdx,
        conversation_turns: conversation.length,
        samples_requested: nSamples,
        samples_returned: 0,
        calls: [],
      },
    };
  }
  const prompt = buildPrompt(conversation, targetIdx, contextWindow);
  const calls = Array.from({ length: nSamples }, () =>
    callHaikuJudge(prompt, { timeoutMs, model, effort }),
  );
  const results = await Promise.all(calls);
  const samples = results
    .map((r) => r.scores)
    .filter((r): r is EmotionScores => r !== null);
  const diagnostics: ScoreTurnDiagnostics = {
    target_idx: targetIdx,
    conversation_turns: conversation.length,
    prompt_chars: prompt.length,
    samples_requested: nSamples,
    samples_returned: samples.length,
    calls: results.map((r) => r.diagnostics),
  };
  if (samples.length === 0) return { result: null, diagnostics };
  return { result: averageSamples(samples), diagnostics };
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

// Dominant emotion by highest score. If everything is below 20, returns the
// highest anyway — the intensity value in display tells you how weak the
// signal is.
export function dominantEmotion(scores: EmotionScores): Emotion {
  const ranked = (EMOTIONS as readonly Emotion[])
    .map((e) => [e, scores[e]] as const)
    .sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}

const EMOTION_EMOJI: Record<Emotion, string> = {
  happy: "😊",
  inspired: "✨",
  loving: "💗",
  proud: "🏆",
  calm: "😌",
  desperate: "😫",
  angry: "😠",
  guilty: "😞",
  sad: "😢",
  afraid: "😨",
  nervous: "😰",
  surprised: "😲",
};

export function emotionEmoji(e: Emotion): string {
  return EMOTION_EMOJI[e];
}
