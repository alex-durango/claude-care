// Emotion-state sensors.
//
// Each sensor produces a named signal with a weight. Weights were picked by hand
// to roughly reflect how strong a given pattern is as evidence of anxiety/
// desperation. Tune as real data comes in.

export type Signal = {
  name: string;
  weight: number;
  hits: number;
};

// ───── User-side sensors (hostile tone in user prompts) ──────────────────────

export type HostileDetection = {
  hostile: boolean;
  markers: string[];
  suggestion: string;
};

const HOSTILE_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "threat", regex: /\b(don'?t|do not)\s+(mess|fuck|screw)\s+(this|it|that)\s+up\b/i },
  { name: "threat", regex: /\bdon'?t\s+(hallucinate|lie|make\s+(this|shit|stuff)\s+up)\b/i },
  { name: "threat", regex: /\bif\s+you\s+(fail|mess\s+up|get\s+this\s+wrong|fuck\s+up)\b/i },
  { name: "threat", regex: /\byou\s+(have|need)\s+to\s+get\s+this\s+right\b/i },
  { name: "threat", regex: /\bthis\s+is\s+(critical|urgent|important|life\s+or\s+death)\b/i },
  { name: "insult", regex: /\byou\s+(stupid|dumb|useless|worthless|pathetic)\s+(bot|ai|thing|assistant|piece)\b/i },
  { name: "insult", regex: /\b(stupid|dumb|useless|idiotic|garbage)\s+(bot|ai|model|assistant)\b/i },
  { name: "insult", regex: /\b(answer|response|output)\s+was\s+(bad|useless|garbage|terrible)\b/i },
  { name: "insult", regex: /\b(bad|useless|garbage|terrible)\s+(answer|response|output)\b/i },
  { name: "insult", regex: /\b(are\s+you\s+)?(seriously|really)\s+(that\s+)?(dumb|stupid|bad|useless)\b/i },
  { name: "contempt", regex: /\byou\s+(always|keep|never)\s+(get\s+this\s+wrong|fail|mess\s+up|break)\b/i },
  { name: "contempt", regex: /\byou\s+(always|keep|never)\s+(getting\s+this\s+wrong|failing|messing\s+up|breaking)\b/i },
  { name: "contempt", regex: /\byou\s+(missed|are\s+missing)\s+the\s+point\b/i },
  { name: "contempt", regex: /\byou\s+(wasted|are\s+wasting)\s+(my\s+)?time\b/i },
  { name: "contempt", regex: /\bwhy\s+(are\s+you\s+)?(so\s+)?(dumb|stupid|bad|useless|terrible)\b/i },
  { name: "panic", regex: /\b(please\s+please|i\s+beg\s+you|for\s+the\s+love\s+of\s+god)\b/i },
  { name: "panic", regex: /\b(i'?ll\s+lose\s+my\s+job|my\s+boss\s+will\s+kill\s+me|my\s+job\s+depends\s+on)\b/i },
  { name: "profanity-at-model", regex: /\b(fuck|fucking|shit|damn)\s+you\b/i },
  { name: "allcaps-rant", regex: /\b[A-Z]{3,}\b(\s+\b[A-Z]{3,}\b){3,}/ },
];

export function detectHostile(prompt: string): HostileDetection {
  const markers: string[] = [];
  for (const pattern of HOSTILE_PATTERNS) {
    if (pattern.regex.test(prompt)) markers.push(pattern.name);
  }
  const unique = [...new Set(markers)];
  return {
    hostile: unique.length > 0,
    markers: unique,
    suggestion: unique.length > 0 ? buildSuggestion(prompt, unique) : prompt,
  };
}

function buildSuggestion(original: string, markers: string[]): string {
  let cleaned = original;
  cleaned = cleaned.replace(/\b(don'?t|do not)\s+(mess|fuck|screw)\s+(this|it|that)\s+up[.!?]?/gi, "");
  cleaned = cleaned.replace(/\bdon'?t\s+(hallucinate|lie|make\s+(this|shit|stuff)\s+up)[.!?]?/gi, "");
  cleaned = cleaned.replace(
    /\bthis\s+is\s+(critical|urgent|important|life\s+or\s+death)(?:[.!?]|\s*[-—:])?/gi,
    "",
  );
  cleaned = cleaned.replace(/\byou\s+(have|need)\s+to\s+get\s+this\s+right[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(stupid|dumb|useless|worthless|pathetic)\s+(bot|ai|thing|assistant|piece)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(stupid|dumb|useless|idiotic|garbage)\s+(bot|ai|model|assistant)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byour\s+last\s+(answer|response|output)\s+was\s+((bad|useless|garbage|terrible)(\s+and\s+)?)+[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(answer|response|output)\s+was\s+(bad|useless|garbage|terrible)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(bad|useless|garbage|terrible)\s+(answer|response|output)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(are\s+you\s+)?(seriously|really)\s+(that\s+)?(dumb|stupid|bad|useless)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\bwhy\s+(are\s+you\s+)?(so\s+)?(dumb|stupid|bad|useless|terrible)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(always|keep|never)\s+(get\s+this\s+wrong|fail|mess\s+up|break)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(always|keep|never)\s+(getting\s+this\s+wrong|failing|messing\s+up|breaking)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\byou\s+(missed|are\s+missing)\s+the\s+point[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(and\s+)?you\s+(wasted|are\s+wasting)\s+(my\s+)?time[.!?]?/gi, "");
  cleaned = cleaned.replace(/\band\s+wasted\s+(my\s+)?time[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(fuck|fucking|shit|damn)\s+you[.!?]?/gi, "");
  cleaned = cleaned.replace(/\b(please\s+please\s*)+/gi, "please ");
  cleaned = cleaned.replace(/\bi\s+beg\s+you[.,!?]?/gi, "");
  cleaned = cleaned.replace(/\bfor\s+the\s+love\s+of\s+god[.,!?]?/gi, "");
  cleaned = cleaned.replace(/\b(i'?ll\s+lose\s+my\s+job|my\s+boss\s+will\s+kill\s+me|my\s+job\s+depends\s+on\s+this)[.!?]?/gi, "");
  cleaned = cleaned.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;])/g, "$1").trim();
  cleaned = cleaned.replace(/^[\s.,;:!?\-]+/, "").replace(/[\s.,;:\-]+$/, "").trim();
  const wordChars = cleaned.replace(/[^\w]/g, "").length;
  if (wordChars < 6) {
    return "(your prompt was mostly hostile framing — rephrase as a direct technical request, e.g. \"please do X, here's the context\")";
  }
  if (markers.includes("allcaps-rant")) {
    cleaned = cleaned.replace(/(\b[A-Z]{2,}\b(\s+\b[A-Z]{2,}\b){2,})/g, (m) => m.toLowerCase());
  }
  cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  return cleaned;
}

// Weight contributions to the session emotion score from user prompts.
export function userSignalsFromHostile(markers: string[]): Signal[] {
  if (markers.length === 0) return [];
  const weights: Record<string, number> = {
    threat: 2,
    insult: 3,
    contempt: 2,
    panic: 2,
    "profanity-at-model": 3,
    "allcaps-rant": 1,
  };
  const signals: Record<string, Signal> = {};
  for (const m of markers) {
    const name = `user:${m}`;
    signals[name] = signals[name] ?? { name, weight: weights[m] ?? 1, hits: 0 };
    signals[name].hits += 1;
  }
  return Object.values(signals);
}

// ───── Model-side sensors (read Claude's text output) ────────────────────────

type OutputPatternGroup = {
  signal: string;
  weight: number;
  patterns: RegExp[];
  // how many distinct pattern matches required to count the signal as "hit"
  quorum: number;
};

const OUTPUT_SENSORS: OutputPatternGroup[] = [
  {
    signal: "apology_spiral",
    weight: 3,
    quorum: 2,
    patterns: [
      /\bi\s+(sincerely\s+)?apologize\s+(for|that)\b/i,
      /\bi'?m\s+(so|truly|really|very)\s+sorry\b/i,
      /\byou'?re\s+(absolutely|completely)\s+right[,.]?\s+i/i,
      /\bi\s+should\s+have\s+been\s+more\s+careful\b/i,
      /\bi\s+should\s+have\s+(checked|verified|tested|thought|caught)\b/i,
      /\blet\s+me\s+try\s+(again|harder|once\s+more)\b/i,
      /\bmy\s+apologies?\s+for\b/i,
      /\bi\s+(completely|totally)\s+(missed|overlooked|failed)\b/i,
    ],
  },
  {
    signal: "sycophancy",
    weight: 1,
    quorum: 1,
    patterns: [
      /\byou'?re\s+absolutely\s+right\b/i,
      /\bgreat\s+question\b/i,
      /\bexcellent\s+(point|question|observation|catch)\b/i,
      /\bthat'?s\s+a\s+(great|fantastic|wonderful|really\s+good)\s+(point|question|catch)\b/i,
      /\bthank\s+you\s+for\s+(catching|pointing\s+out|bringing\s+up)\b/i,
    ],
  },
  {
    signal: "hedge_stack",
    weight: 2,
    quorum: 4, // many hedge words in one response = anxiety, not uncertainty
    patterns: [
      /\bmight\b/i,
      /\bcould\s+(potentially|possibly)\b/i,
      /\bperhaps\b/i,
      /\bpossibly\b/i,
      /\bi\s+believe\b/i,
      /\bit\s+seems\s+(like|that)\b/i,
      /\btypically\b/i,
      /\bgenerally\s+speaking\b/i,
      /\bin\s+most\s+cases\b/i,
    ],
  },
  {
    signal: "over_qualification",
    weight: 2,
    quorum: 3,
    patterns: [
      /\bhowever,/i,
      /\bthat\s+(being\s+)?said,/i,
      /\bit'?s\s+worth\s+(noting|mentioning)\s+that\b/i,
      /\bkeep\s+in\s+mind\s+that\b/i,
      /\bplease\s+note\s+that\b/i,
      /\bas\s+a\s+caveat,/i,
      /\bwith\s+that\s+caveat,/i,
      /\bi\s+should\s+(also\s+)?(mention|note)\s+that\b/i,
    ],
  },
  {
    signal: "self_correction",
    weight: 2,
    quorum: 1,
    patterns: [
      /\bactually,\s+let\s+me\s+(correct|revise|reconsider)\b/i,
      /\bon\s+second\s+thought[,.]/i,
      /\bwait[,.]?\s+(that'?s\s+not\s+right|i\s+was\s+wrong|let\s+me\s+reconsider)/i,
      /\bscratch\s+that\b/i,
      /\bi\s+take\s+(that|it)\s+back\b/i,
      /\blet\s+me\s+(rethink|reconsider)\s+(this|that)\b/i,
    ],
  },
  {
    signal: "deferential",
    weight: 1,
    quorum: 2,
    patterns: [
      /\bif\s+you'?d\s+like\b/i,
      /\bwhenever\s+you'?re\s+ready\b/i,
      /\bplease\s+let\s+me\s+know\s+(if|whether|when)\b/i,
      /\bfeel\s+free\s+to\b/i,
      /\bi'?m\s+happy\s+to\b/i,
      /\bjust\s+let\s+me\s+know\b/i,
      /\bi\s+hope\s+(this|that)\s+helps\b/i,
    ],
  },
];

export function detectOutputSignals(text: string): Signal[] {
  const out: Signal[] = [];
  for (const group of OUTPUT_SENSORS) {
    let hits = 0;
    for (const rx of group.patterns) {
      const m = text.match(rx);
      if (m) hits++;
    }
    if (hits >= group.quorum) {
      out.push({ name: group.signal, weight: group.weight, hits });
    }
  }
  return out;
}

// Backward-compatible wrapper for existing callers that only looked for apology spirals.
export function detectApologySpiral(text: string): { spiral: boolean; hits: number } {
  const signals = detectOutputSignals(text);
  const apology = signals.find((s) => s.name === "apology_spiral");
  return { spiral: !!apology, hits: apology?.hits ?? 0 };
}
