// §24.5 — Five-level tone resolution.
//
// Resolves the effective tone level (1..5) for an AI response based on:
//   • Tenant ceiling (tenant_settings.persona_tone_max_level, default 3)
//   • Persona base inclination (lib/chat/persona-base-tones.ts)
//   • Customer's apparent style from current message (deterministic heuristic
//     — no Haiku call here; the spec mentions a Haiku call but we ship the
//     deterministic version first. TODO(tone-haiku) for richer detection.)
//   • Customer override stored in customer_memories.rapport_tone_level
//     (acts as a FLOOR unless topic override is stricter)
//   • Topic-aware modulation: medical/financial/cancellation/booking-confirmation
//     pull the level DOWN regardless of other inputs.
//
// The resolved level is rendered into the persona's system prompt by the chat
// handler via lib/personas/build-system-prompt.ts (TONE_CALIBRATION placeholder).

import { basePersonaTone } from "./persona-base-tones";

export type ToneLevel = 1 | 2 | 3 | 4 | 5;

export type ToneSource =
  | "tenant_default"
  | "persona_default"
  | "inferred"
  | "customer_override"
  | "topic_override";

export type ToneTopic =
  | "medical_accessibility"
  | "financial"
  | "cancellation_complaint"
  | "booking_confirmation"
  | "casual_exploration";

export type ResolveToneInput = {
  tenant_max_level: number;         // tenant_settings.persona_tone_max_level (1..5)
  persona_slug: string | null;
  customer_rapport_level: number | null; // customer_memories.rapport_tone_level
  customer_rapport_directive: "direct" | null;
  customer_message: string;
  topic?: ToneTopic;                // pre-classified topic (from entity extraction or null)
};

export type ResolveToneOutput = {
  level: ToneLevel;
  source: ToneSource;
};

// §24.5 topic-aware modulation table.
const TOPIC_CAPS: Record<ToneTopic, [number, number]> = {
  medical_accessibility:  [1, 2],
  financial:              [2, 3],
  cancellation_complaint: [1, 2],
  booking_confirmation:   [2, 2],
  casual_exploration:     [1, 5], // unrestricted
};

// Deterministic apparent-style classifier. Returns 2 (formal-ish) or 4
// (casual) based on simple lexical signals — slang words, exclamation density,
// contractions, profanity. This is a stand-in for the spec's Haiku call.
function inferCustomerStyle(message: string): ToneLevel {
  const text = message.toLowerCase();
  let casualSignals = 0;
  // contractions: don't / can't / it's. Includes both ASCII apostrophe
  // (U+0027) and curly right-single-quote (U+2019) because iOS/macOS/Word
  // auto-replace ASCII with curly — without this, contractions from any
  // mobile or modern desktop user are silently missed.
  if (/['’]\w+/.test(text)) casualSignals++;
  if (/\b(hey|yo|sup|wanna|gonna|gotta|kinda|lol|haha|omg|tbh|fr|ngl)\b/.test(text)) casualSignals++;
  if ((text.match(/!/g) ?? []).length >= 2) casualSignals++;
  if (text.length < 60 && /[?!]$/.test(text.trim())) casualSignals++;
  if (casualSignals >= 2) return 4;
  if (casualSignals === 1) return 3;
  return 2;
}

function clamp(level: number, min: number, max: number): ToneLevel {
  if (level < min) return min as ToneLevel;
  if (level > max) return max as ToneLevel;
  return level as ToneLevel;
}

export function resolveToneLevel(input: ResolveToneInput): ResolveToneOutput {
  const tenantMax = Math.min(5, Math.max(1, input.tenant_max_level || 3));
  const personaBase = basePersonaTone(input.persona_slug);

  // 1. Apparent customer style.
  const apparent = inferCustomerStyle(input.customer_message);

  // 2. Initial level: midpoint between apparent style and tenant default (3 baseline).
  let level: number = Math.round((apparent + personaBase) / 2);
  let source: ToneSource = "inferred";

  // 3. Adjust upward toward apparent style, capped by tenant max.
  if (apparent > level && apparent <= tenantMax) {
    level = apparent;
  }

  // 4. Customer override acts as a FLOOR (per spec) within tenant cap.
  if (input.customer_rapport_level !== null) {
    const override = clamp(input.customer_rapport_level, 1, tenantMax);
    if (override > level) {
      level = override;
      source = "customer_override";
    }
    // Customer "cut the small talk" → directive='direct' → floor at 2 (no warmth padding)
    if (input.customer_rapport_directive === "direct") {
      level = Math.min(level, 2);
      source = "customer_override";
    }
  }

  // 5. Topic override always wins (strictest).
  if (input.topic && input.topic !== "casual_exploration") {
    const [topicMin, topicMax] = TOPIC_CAPS[input.topic];
    if (level < topicMin) level = topicMin;
    if (level > topicMax) level = topicMax;
    source = "topic_override";
  }

  // 6. Final tenant cap (must hold).
  level = Math.min(level, tenantMax);
  level = Math.max(1, level);

  return { level: level as ToneLevel, source };
}
