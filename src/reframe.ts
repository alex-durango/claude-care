import { spawn } from "node:child_process";

// Compressed principle set. Longer instructions make haiku noticeably slower —
// 400 chars is ~3s, 1400 chars is ~15s. Haiku's smart enough to apply these
// principles from terse cues.
//
// Principles compressed here: Nonviolent Communication (observation+need+
// request, drop blame), positive framing (what to DO), permission to disagree,
// cognitive reframing (no catastrophizing). Plus a hard rule to preserve
// technical details and match length.
const REFRAMER_INSTRUCTION = `Rewrite the prompt below for a coding AI: drop threats, catastrophizing, blame, and "don't X" phrasing; use positive framing ("do X"); preserve ALL technical details (file paths, names, commands, errors); match the original length; add a brief "push back if there's a better angle" only if the original demands one specific approach. Return ONLY the rewrite, no preamble, no quotes, no commentary.

Prompt:
{prompt}`;

const PROMPT_REVIEW_INSTRUCTION = `Review this Claude Code user prompt before it reaches a coding AI.
Block only for hostile/performance-risk tone: threats, insults, contempt, panic/catastrophizing, profanity at the model, all-caps ranting, or hostile "don't mess up / don't hallucinate / don't lie" framing.
Allow calm requests, ordinary urgency, bug reports, direct technical criticism, and normal frustration.
If blocked, rewrite it for the coding AI: preserve every technical detail, remove hostile/pressure framing, use direct positive instructions, and add no new requirements.
Return ONLY compact JSON, no markdown:
{"action":"allow","markers":[],"rewrite":"","reason":""}
or
{"action":"block","markers":["insult"],"rewrite":"...","reason":"..."}

Prompt:
{prompt}`;

const REFRAMER_TIMEOUT_MS = 20_000;
const DEFAULT_MODEL = "haiku";
const DEFAULT_EFFORT = "low";

export type ReframeResult = {
  reframed: string;
  source: "haiku" | "fallback";
  ms: number;
};

export type PromptReviewResult = {
  action: "allow" | "block";
  markers: string[];
  rewrite: string;
  source: "haiku" | "fallback";
  rewriteSource: "haiku" | "fallback" | "none";
  ms: number;
  reason?: string;
  error?: string;
};

export type HaikuCallOptions = {
  model?: string;
  effort?: string;
  timeoutMs?: number;
};

type PromptReviewFallback = {
  hostile: boolean;
  markers: string[];
  suggestion: string;
};

// Reframe a hostile/stressed prompt via a haiku subagent. Falls back to the
// regex-based suggestion if haiku is unreachable (no `claude` binary, auth
// issue, timeout, etc.) — the caller is expected to pass `fallback` ready.
export async function reframeWithHaiku(
  prompt: string,
  fallback: string,
  options: HaikuCallOptions = {},
): Promise<ReframeResult> {
  const start = Date.now();
  try {
    const rewritten = await callHaiku(REFRAMER_INSTRUCTION.replace("{prompt}", prompt), options);
    const cleaned = sanitizeReframe(rewritten, prompt);
    if (!cleaned) throw new Error("empty reframe");
    return { reframed: cleaned, source: "haiku", ms: Date.now() - start };
  } catch {
    return { reframed: fallback, source: "fallback", ms: Date.now() - start };
  }
}

export async function reviewPromptWithHaiku(
  prompt: string,
  fallback: PromptReviewFallback,
  options: HaikuCallOptions = {},
): Promise<PromptReviewResult> {
  const start = Date.now();
  try {
    const raw = await callHaiku(PROMPT_REVIEW_INSTRUCTION.replace("{prompt}", prompt), options);
    const parsed = parsePromptReview(raw, prompt, fallback);
    return { ...parsed, source: "haiku", ms: Date.now() - start };
  } catch (err) {
    const fallbackRewrite = fallbackRewriteFor(prompt, fallback.suggestion);
    return {
      action: fallback.hostile ? "block" : "allow",
      markers: fallback.hostile ? fallback.markers : [],
      rewrite: fallback.hostile ? fallbackRewrite : "",
      source: "fallback",
      rewriteSource: fallback.hostile ? "fallback" : "none",
      ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function callHaiku(fullPrompt: string, options: HaikuCallOptions = {}): Promise<string> {
  const args = [
    "-p",
    fullPrompt,
    "--model",
    options.model || DEFAULT_MODEL,
    "--effort",
    options.effort || DEFAULT_EFFORT,
    "--output-format",
    "text",
  ];
  const timeoutMs = options.timeoutMs ?? REFRAMER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Mark this call as internal so our own hooks no-op on the subprocess
      // (prevents recursion when the reframer's prompt mentions hostile text).
      env: { ...process.env, CLAUDE_CARE_INTERNAL: "1" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("reframer timeout"));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

function parsePromptReview(
  raw: string,
  original: string,
  fallback: PromptReviewFallback,
): Omit<PromptReviewResult, "source" | "ms" | "error"> {
  const jsonText = extractJsonObject(raw);
  const parsed = JSON.parse(jsonText) as {
    action?: unknown;
    markers?: unknown;
    rewrite?: unknown;
    reason?: unknown;
  };
  const action = parsed.action === "block" ? "block" : "allow";
  const markers = normalizeMarkers(parsed.markers);
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 240) : undefined;

  if (action === "allow") {
    return { action, markers: [], rewrite: "", rewriteSource: "none", reason };
  }

  const rewrite = sanitizeReframe(String(parsed.rewrite ?? ""), original);
  if (rewrite) {
    return {
      action,
      markers: markers.length ? markers : ["tone-risk"],
      rewrite,
      rewriteSource: "haiku",
      reason,
    };
  }

  return {
    action,
    markers: markers.length ? markers : fallback.markers.length ? fallback.markers : ["tone-risk"],
    rewrite: fallbackRewriteFor(original, fallback.suggestion),
    rewriteSource: "fallback",
    reason,
  };
}

function extractJsonObject(raw: string): string {
  const text = raw.trim();
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("review returned no JSON");
  return match[0];
}

function normalizeMarkers(markers: unknown): string[] {
  if (!Array.isArray(markers)) return [];
  const normalized = markers
    .map((m) => String(m).toLowerCase().trim())
    .map((m) => m.replace(/\s+/g, "-"))
    .filter((m) => /^[a-z][a-z0-9-]{1,40}$/.test(m));
  return [...new Set(normalized)].slice(0, 6);
}

function fallbackRewriteFor(original: string, fallback: string): string {
  const cleaned = sanitizeReframe(fallback, original);
  if (cleaned && cleaned !== original.trim()) return cleaned;
  return "Please restate this as a direct technical request, preserving the concrete task and context.";
}

// Guard against haiku misbehaving — strip wrappers it sometimes adds, reject
// output that clearly isn't a reframe of the original.
function sanitizeReframe(raw: string, original: string): string {
  let text = raw.trim();
  // Strip surrounding quotes haiku sometimes adds
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Strip "Here's the rewrite:" style preambles
  text = text.replace(/^(here('?s|\s+is)\s+the\s+(rewrite|rewritten\s+prompt|reframe(d\s+prompt)?)[:.]?\s*)/i, "");
  text = text.replace(/^(rewritten\s+prompt:|reframed:)\s*/i, "");
  text = text.trim();
  // Reject obviously degenerate output
  if (text.length < 3) return "";
  // If haiku returned something much longer than the original, something's off
  if (text.length > original.length * 6 + 200) return "";
  return text;
}
