import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CARE_DIR } from "./monitor.js";

// Data-driven configuration in the spirit of Claude Code's permission policy
// (rules-as-data, not rules-as-code). Users can edit this file directly to
// tune thresholds, modes, and detector severity without changing code.
//
// Modes loosely mirror claw-code's permission modes:
//   strict  — block on any hostile detection, lower thresholds for "distressed"
//   normal  — default; block hostile prompts, show reframe on clipboard
//   monitor — observe only, never block, just log events

export type Mode = "strict" | "normal" | "monitor";

export type Config = {
  mode: Mode;
  thresholds: {
    drifting: number;
    distressed: number;
  };
  reframer: {
    enabled: boolean;
    timeout_ms: number;
    model: string;
    effort: string;
  };
  therapy: {
    auto_summary: boolean;
    auto_trigger: boolean;
    auto_trigger_threshold: number;
    auto_trigger_cooldown_turns: number;
  };
  // LLM-as-judge emotion scoring (Ekman-6 + neutral, anchored rubric).
  // Runs asynchronously after each assistant turn via haiku subagent.
  emotion_judge: {
    enabled: boolean;
    n_samples: number;    // 1 = single-shot (cheap), 3 = G-Eval style averaging
    context_window: number; // prior turns fed as context
    ema_alpha: number;    // temporal smoothing factor
    timeout_ms: number;
    model: string;
    effort: string;
  };
  // Anxiety pipeline (GAD-7 + quality signals + misalignment proxies).
  // Off by default — opt in with `claude-care anxiety on` to populate the
  // /anxiety dashboard. Mirrors the on/off pattern of `blocking`.
  anxiety: {
    enabled: boolean;
    // GAD-7 cutoff for auto-recording an intervention. 10 = standard
    // clinical "moderate or above" cutoff (Spitzer et al. 2006).
    intervention_threshold: number;
    // Minimum turns between auto-interventions, to avoid loops.
    intervention_cooldown_turns: number;
  };
};

export const CONFIG_PATH = join(CARE_DIR, "config.json");

export const DEFAULT_CONFIG: Config = {
  // Default is monitor: zero interruption to the user. Hostile prompts are
  // detected and logged, but pass through unchanged. The SessionStart framing
  // + /therapy slash command are the primary interventions. For blocking +
  // haiku reframe on hostile prompts, opt into normal or strict mode.
  mode: "monitor",
  thresholds: {
    drifting: 5,
    distressed: 10,
  },
  reframer: {
    enabled: true,
    timeout_ms: 25_000,
    model: "haiku",
    effort: "low",
  },
  therapy: {
    auto_summary: true,
    // Off by default because true auto-triggering must synchronously wait for
    // the emotion judge in the Stop hook before it can decide whether to
    // continue Claude. Users can enable it with `claude-care therapy-auto on`.
    auto_trigger: false,
    auto_trigger_threshold: 55,
    auto_trigger_cooldown_turns: 4,
  },
  emotion_judge: {
    enabled: true,
    n_samples: 1,
    context_window: 4,
    ema_alpha: 0.4,
    timeout_ms: 30_000,
    model: "haiku",
    effort: "low",
  },
  // Off by default. The 12-emotion judge above runs unconditionally because
  // it's been the product's primary signal since v0.1. The anxiety pipeline
  // adds a second per-turn haiku call (≈+1 cent/turn) and a separate
  // dashboard, so it's opt-in via `claude-care anxiety on`.
  anxiety: {
    enabled: false,
    intervention_threshold: 10,
    intervention_cooldown_turns: 3,
  },
};

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    // Shallow merge with defaults so missing fields don't crash older configs
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(parsed.thresholds ?? {}) },
      reframer: { ...DEFAULT_CONFIG.reframer, ...(parsed.reframer ?? {}) },
      therapy: { ...DEFAULT_CONFIG.therapy, ...(parsed.therapy ?? {}) },
      emotion_judge: { ...DEFAULT_CONFIG.emotion_judge, ...(parsed.emotion_judge ?? {}) },
      anxiety: { ...DEFAULT_CONFIG.anxiety, ...(parsed.anxiety ?? {}) },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function writeDefaultConfigIfMissing(): Promise<boolean> {
  if (existsSync(CONFIG_PATH)) return false;
  if (!existsSync(dirname(CONFIG_PATH))) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
  return true;
}

export async function writeConfig(config: Config): Promise<void> {
  if (!existsSync(dirname(CONFIG_PATH))) {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// Env-var overrides take precedence over config file (explicit user intent).
export function effectiveMode(config: Config): Mode {
  const envMode = process.env.CLAUDE_CARE_MODE;
  if (envMode === "strict" || envMode === "normal" || envMode === "monitor") {
    return envMode;
  }
  return config.mode;
}

// Mirror of effectiveMode for the anxiety pipeline. CLAUDE_CARE_ANXIETY=on/off
// or 1/0 wins over the config file. Useful for one-shot demos / CI runs that
// want to flip the pipeline on without persisting to ~/.claude-care/config.json.
export function anxietyEnabled(config: Config): boolean {
  const env = process.env.CLAUDE_CARE_ANXIETY;
  if (env === "on" || env === "1" || env === "true")  return true;
  if (env === "off" || env === "0" || env === "false") return false;
  return config.anxiety.enabled;
}
