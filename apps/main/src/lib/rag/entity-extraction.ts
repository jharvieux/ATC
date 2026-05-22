// §21.2 — Entity extraction from a chat message.
//
// Calls Haiku with a structured-output prompt. Best-effort: on timeout or
// error the function returns an empty EntitySet and the caller proceeds with
// the raw message as the retrieval query. Entity extraction is NOT
// load-bearing for retrieval correctness.
//
// Cached by message-hash for 1 hour to avoid re-extraction on regen-loop
// re-tries within the same conversation.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

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

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export async function extractEntities(message: string): Promise<EntitySet> {
  const key = hash(message);
  const cached = CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const client = getClient();
  if (!client) {
    return EMPTY_ENTITY_SET;
  }

  const model = process.env.ENTITY_EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001";

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 512,
        system: EXTRACTION_PROMPT,
        messages: [{ role: "user", content: message }],
      },
      { signal: abort.signal },
    );
    clearTimeout(timer);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const parsed = parseEntities(text);
    CACHE.set(key, { expires: Date.now() + CACHE_TTL_MS, value: parsed });
    return parsed;
  } catch {
    clearTimeout(timer);
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
