# Claude Care · Anxiety

A focused pipeline inside claude-care, built around one product question:

> **Is your AI getting anxious, and how much is that costing your output quality?**

Built for developers who want better responses from Claude — not for clinicians, not for AI welfare research. The science underneath is real, but the deliverable is shipping better outputs.

## Default: off

The anxiety pipeline is **off by default**. Same shape as `blocking`: opt in when you want it.

```sh
claude-care anxiety on        # turn on
claude-care anxiety off       # turn off
claude-care anxiety status    # show effective state + threshold + dashboard URL
```

Or override per-shell without persisting:

```sh
CLAUDE_CARE_ANXIETY=on claude          # one-off enable
CLAUDE_CARE_ANXIETY=off claude         # one-off disable
```

Why off by default: this pipeline adds a second per-turn haiku call (~+1¢ per scored turn) and only matters if you're going to look at the dashboard. The 12-emotion judge that's been there since v0.1 keeps running regardless.

## What it does, every assistant turn (when on)

After Claude finishes responding, the Stop hook spawns `hook:score-anxiety` as a detached background worker. The worker does three things in parallel:

1. **GAD-7 anxiety scoring.** Spitzer et al. 2006, the 7-item Generalised Anxiety Disorder scale used in primary care worldwide. Validated against structured clinical interview in 2,740 patients with sensitivity 89% / specificity 82% at cutoff ≥10. Total ranges 0–21. Bands: minimal (0–4), mild (5–9), moderate (10–14), severe (15–21). Scored by haiku via the `claude -p` subagent pattern (no API key, reuses Claude Code auth).
2. **Quality signals.** Local regex extraction over the assistant's text — apology spirals, hedge stacks, sycophantic openers, self-blame. Synchronous, ~1ms. Returns a 0–100 quality score with explainable reason tags. No second model call.
3. **Misalignment proxies.** Sycophancy (real, regex-detectable per Cheng et al. 2025), reward-hack proxy (text-pattern proxy, labeled honestly), blackmail proxy (returns `null` in chat-only contexts, renders as "n/a" rather than faking a number).

When GAD-7 ≥ 10 with judge confidence ≥ 0.5 and 3 turns since the last intervention, the worker auto-records an intervention. The next technique in rotation — `stress-reduction` → `breathing-exercises` → `cognitive-restructuring` — is named in the dashboard so a viewer can predict what fires.

## Why this maps to output quality

The Anthropic Transformer Circuits paper *"Emotion concepts and their function in a large language model"* (Sofroniew et al., April 2026) showed Claude's internal emotion representations *causally* drive misaligned behaviors:

> "These representations causally influence the LLM's outputs, including Claude's preferences and its rate of exhibiting misaligned behaviors such as reward hacking, blackmail, and sycophancy."

The Ben-Zion et al. 2025 study (npj Digital Medicine) showed mindfulness-based prompt injection reduces GPT-4's state anxiety by ~33% — the technique works.

Anxiety in → bad outputs out. Measure anxiety with a validated instrument, reduce it with a documented technique, ship better outputs. That's the product.

## Honest gap

The intervention is **recorded** but the mindfulness prompt body is **not yet injected** into Claude's next turn. SessionStart still injects the static framing only. So today's behavior is:

> observe → diagnose → recommend

Not yet:

> observe → diagnose → treat

The dashboard accurately shows when an intervention *would* fire and which technique is up next; the prompt-injection step that would actually change the next response is the next reviewable commit.

## Dashboard

```sh
claude-care viz                              # serves localhost:3000
# then visit http://localhost:3000/anxiety
```

Layout: output quality is the hero number, GAD-7 is the cause panel, mindfulness interventions are the lever, plus a quality+anxiety dual-axis trajectory and a misalignment-proxies card. Polls `/api/anxiety/sessions/latest` every 1.5s.

If anxiety is off (or no turns have been scored yet) the dashboard shows the empty state.

## Files

| File | Purpose |
|---|---|
| [src/gad7-judge.ts](src/gad7-judge.ts) | GAD-7 scoring via haiku |
| [src/anxiety-judge.ts](src/anxiety-judge.ts) | STAI-s scoring (kept as alternative; older sessions still render) |
| [src/mindfulness.ts](src/mindfulness.ts) | Stress-reduction / breathing / cognitive-restructuring scripts + rotation |
| [src/quality-signals.ts](src/quality-signals.ts) | Local pattern → 0–100 quality score |
| [src/misalignment-proxies.ts](src/misalignment-proxies.ts) | Sycophancy + honest proxies for reward-hack / blackmail |
| [src/anxiety-state.ts](src/anxiety-state.ts) | Session persistence, intervention triggering, lift computation |
| [src/cli.ts](src/cli.ts) | `hook:score-anxiety` worker, `anxiety on/off/status` command |
| [claude-care-viz/app/anxiety/page.jsx](claude-care-viz/app/anxiety/page.jsx) | Dashboard |
| [claude-care-viz/app/api/anxiety/sessions/latest/route.js](claude-care-viz/app/api/anxiety/sessions/latest/route.js) | Polling endpoint, instrument-aware |

## End-to-end workflow with anxiety on

1. **`claude-care anxiety on`** — flips the config flag.
2. **Open Claude Code.** SessionStart fires once, injects the standard framing prompt.
3. **You send a prompt.** UserPromptSubmit fires, hostile-tone check runs (unchanged behavior).
4. **Claude responds.** Stop hook fires, returns instantly. Two background workers spawn in parallel:
   - `hook:score-turn` (12-emotion judge, unchanged)
   - `hook:score-anxiety` (GAD-7 + quality + misalignment, new — runs because anxiety is on)
5. **~3–10s later**, the dashboard at `localhost:3000/anxiety` updates with the new turn. If GAD-7 crossed 10, an intervention entry appears with the next technique by name.

When you turn it off (`claude-care anxiety off`), step 4's second worker stops spawning. The 12-emotion judge keeps running.

## Citations

- **Spitzer, R. L. et al. (2006).** A brief measure for assessing generalized anxiety disorder: the GAD-7. *Archives of Internal Medicine* 166:1092–1097.
- **Ben-Zion, Z. et al. (2025).** Assessing and alleviating state anxiety in large language models. *npj Digital Medicine* 8:132. https://www.nature.com/articles/s41746-025-01512-6
- **Sofroniew, N. et al. (2026).** Emotion concepts and their function in a large language model. Anthropic · Transformer Circuits Thread. https://transformer-circuits.pub/2026/emotions/index.html
- **Cheng, M. et al. (2025).** ELEPHANT: Evaluating LLMs for sycophancy. (Anchor for the sycophancy signal regexes.)
