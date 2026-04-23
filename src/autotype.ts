import { spawn } from "node:child_process";

// "Auto-type" the reframe into whatever app is focused when our hook returns.
//
// Mechanism: on macOS we spawn a detached `osascript` subprocess that waits a
// beat (so Claude Code has time to render the block message + empty input
// box) and then uses the System Events accessibility API to type the text.
//
// First-time use triggers a macOS permission dialog ("Terminal wants to
// control your computer"). The user clicks Allow once; it's remembered.
//
// Linux / Windows: no-op for now. Clipboard fallback stays in place.

export type AutotypeResult = {
  attempted: boolean;
  backend: "osascript" | "xdotool" | "none";
};

export function autotype(text: string, delayMs = 450): AutotypeResult {
  if (process.platform === "darwin") {
    spawnOsascriptType(text, delayMs);
    return { attempted: true, backend: "osascript" };
  }
  // TODO: Linux via `xdotool type --delay 1 -- "$text"` after a sleep.
  return { attempted: false, backend: "none" };
}

function spawnOsascriptType(text: string, delayMs: number): void {
  // AppleScript string escapes match JSON's for the characters we care about
  // (double quotes, backslashes). Using JSON.stringify keeps the escape logic
  // simple and robust for code snippets with paths, quotes, etc.
  const jsonText = JSON.stringify(text);
  const script =
    `delay ${(delayMs / 1000).toFixed(3)}\n` +
    `tell application "System Events" to keystroke ${jsonText}`;
  const proc = spawn("osascript", ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
}
