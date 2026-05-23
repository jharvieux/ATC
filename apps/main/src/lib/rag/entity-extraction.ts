// §21.2 — Entity extraction from a chat message.
//
// Calls Haiku with a structured-output prompt. Best-effort: on timeout or
// error the function returns an empty EntitySet and the caller proceeds with
// the raw message as the retrieval query. Entity extraction is NOT
// load-bearing for retrieval correctness.
//
// Cached by message-hash for 1 hour to avoid re-extraction on regen-loop
// re-tries within the same conversation.

import { createHash } from "node:crypto";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";

export type EntityIntent = "research" | "compare" | "book" | "support";

export interface EntitySet {
  destinations: string[];
  cruise_lines: string[];
  ships: string[];
  travel_dates: {
    earliest: string | null;
    latest: string | null;
  };
  passenger_composition: string;
  intent: EntityIntent;
  categories_hint: string[];
}

const EMPTY_ENTITY_SET: EntitySet = {
  destinations: [],
  cruise_lines: [],
  ships: [],
  travel_dates: { earliest: null, latest: null },
  passenger_composition: "",
  intent: "research",
  categories_hint: [],
};

const EXTRACTION_PROMPT = `You extract structured travel-search entities from a single chat message.
Return JSON ONLY, no prose. Schema:

{
  "destinations": string[],       // free-text place names mentioned ("Greek Isles", "Barcelona")
  "cruise_lines": string[],       // explicit cruise line names ("Royal Caribbean", "Viking")
  "ships": string[],              // ship names ("Wonder of the Seas")
  "travel_dates": { "earliest": string|null, "latest": string|null }, // ISO YYYY-MM-DD or null
  "passenger_composition": string, // free-text ("couple", "family of 4 with toddler", "solo")
  "intent": "research" | "compare" | "book" | "support",
  "categories_hint": string[]     // helpful retrieval categories ("pricing","schedule","policy","promo")
}

If a field is not mentioned, return an empty array, empty string, or null.
Do not invent specifics that are not in the message.`;

interface CacheEntry {
  expires: number;
  value: EntitySet;
}
const CACHE: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface ExtractEntitiesArgs {
  message: string;
  tenant_id: string;
  user_id?: string | null;
  conversation_id?: string | null;
}

export async function extractEntities(args: ExtractEntitiesArgs | string): Promise<EntitySet> {
  // Backwards-compatible: legacy callers passed a bare string.
  const input: ExtractEntitiesArgs = typeof args === "string"
    ? { message: args, tenant_id: "00000000-0000-0000-0000-000000000000" }
    : args;

  const key = hash(input.message);
  const cached = CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  if (!process.env.ANTHROPIC_API_KEY) return EMPTY_ENTITY_SET;

  const model = process.env.ENTITY_EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001";

  try {
    const result = await instrumentedClaudeCall({
      tenant_id: input.tenant_id,
      user_id: input.user_id ?? null,
      conversation_id: input.conversation_id ?? null,
      model,
      purpose: "entity_extraction",
      max_tokens: 512,
      system: EXTRACTION_PROMPT,
      messages: [{ role: "user", content: input.message }],
    });
    const parsed = parseEntities(result.text);
    CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, value: parsed });
    return parsed;
  } catch {
    return EMPTY_ENTITY_SET;
  }
}

function parseEntities(raw: string): EntitySet {
  try {
    // Strip code fences if present.
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const obj = JSON.parse(cleaned) as Partial<EntitySet>;
    return {
      destinations: Array.isArray(obj.destinations) ? obj.destinations.filter((s) => typeof s === "string") : [],
      cruise_lines: Array.isArray(obj.cruise_lines) ? obj.cruise_lines.filter((s) => typeof s === "string") : [],
      ships: Array.isArray(obj.ships) ? obj.ships.filter((s) => typeof s === "string") : [],
      travel_dates: {
        earliest: obj.travel_dates?.earliest ?? null,
        latest: obj.travel_dates?.latest ?? null,
      },
      passenger_composition: typeof obj.passenger_composition === "string" ? obj.passenger_composition : "",
      intent: ["research", "compare", "book", "support"].includes(obj.intent as string)
        ? (obj.intent as EntityIntent)
        : "research",
      categories_hint: Array.isArray(obj.categories_hint) ? obj.categories_hint.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return EMPTY_ENTITY_SET;
  }
}

// Test seam — clears the in-memory cache.
export function _clearEntityCacheForTests(): void {
  CACHE.clear();
}
