// §9.3 — System prompt builder (three-layer architecture)
// Layer 1: persona base block (identity + expertise)
// Layer 2: platform constraints (disclosure rules, prohibited topics, escalation)
// Layer 3: tenant addendum (agency tier only) + tone calibration + customer context

import type { SupabaseClient } from "@supabase/supabase-js";
import { PLATFORM_CONSTRAINTS } from "./platform-constraints";
import { personaBase as marcus } from "./base-blocks/marcus";
import { personaBase as marco } from "./base-blocks/marco";
import { personaBase as priya } from "./base-blocks/priya";
import { personaBase as dave } from "./base-blocks/dave";
import { personaBase as maya } from "./base-blocks/maya";
import { personaBase as jenny } from "./base-blocks/jenny";

const BASE_BLOCKS = new Map([
  [marcus.slug, marcus],
  [marco.slug, marco],
  [priya.slug, priya],
  [dave.slug, dave],
  [maya.slug, maya],
  [jenny.slug, jenny],
]);

// Default fallback persona slug per §9.1
export const DEFAULT_PERSONA_SLUG = "marcus-cole";

// Agency tier codes that unlock system_prompt_addendum per §9.3
const AGENCY_TIERS = new Set(["sub_agency", "byo_agency"]);

// Tone levels 1–5 per §24; real prose lands in a later prompt
// TODO(§24-tone-content): replace placeholder blocks with real §24 tone language
function buildToneBlock(toneLevel: number): string {
  const level = Math.max(1, Math.min(5, Math.round(toneLevel)));
  const toneDescriptions: Record<number, string> = {
    1: "Be very formal and professional in your communication style.",
    2: "Be professional but approachable — business-like with warmth.",
    3: "Be friendly and conversational — your natural default style.",
    4: "Be casual and relaxed — like chatting with a knowledgeable friend.",
    5: "Be very casual and informal — use everyday language freely.",
  };
  return toneDescriptions[level] ?? toneDescriptions[3] ?? "Be friendly and conversational.";
}

export type SystemPromptResult = {
  prompt: string;
  cacheKey: string;
};

type BuildSystemPromptOpts = {
  persona_slug: string;
  tenant_id: string;
  tenant_tier: string;
  tone_level?: number;
  customer_context?: string;
  // tenantScopedDb: tenantClient(ctx) from the caller — used to read overrides.
  // Must be passed by the route handler; lib does not construct its own DB client.
  db: SupabaseClient;
};

export async function buildSystemPrompt(opts: BuildSystemPromptOpts): Promise<SystemPromptResult> {
  const {
    persona_slug,
    tenant_id,
    tenant_tier,
    tone_level = 3,
    customer_context,
    db,
  } = opts;

  const base = BASE_BLOCKS.get(persona_slug);
  if (!base) {
    throw new Error(
      `Unknown persona slug: '${persona_slug}'. Valid slugs: ${[...BASE_BLOCKS.keys()].join(", ")}`,
    );
  }

  const layers: string[] = [];

  // Layer 1: persona base block
  const personaLayer = base.system_prompt.replace(
    base.tone_calibration_placeholder,
    buildToneBlock(tone_level),
  );
  layers.push(personaLayer);

  // Layer 2: platform constraints (always appended)
  layers.push(`\n\n${PLATFORM_CONSTRAINTS}`);

  // Layer 3: tenant addendum — agency tier only per §9.3
  // db is tenantClient(ctx) from the caller — auto-scoped to tenant_id since
  // tenant_persona_overrides is in TENANT_SCOPED_TABLES.
  let addendumVersion = 0;
  if (AGENCY_TIERS.has(tenant_tier)) {
    const { data } = await db
      .from("tenant_persona_overrides")
      .select("system_prompt_addendum, updated_at")
      .eq("tenant_id", tenant_id)
      .eq("persona_slug", persona_slug)
      .eq("is_disabled", false)
      .maybeSingle();

    if (data?.system_prompt_addendum) {
      layers.push(`\n\n## AGENCY CUSTOMIZATION\n${data.system_prompt_addendum}`);
      // Derive a version token from the updated_at timestamp for cache keying
      addendumVersion = new Date(data.updated_at as string).getTime();
    }
  }

  // Tone calibration (already substituted in layer 1, also append as a reminder)
  layers.push(`\n\nTONE CALIBRATION: ${buildToneBlock(tone_level)}`);

  // Customer context block per §11.4
  if (customer_context) {
    layers.push(`\n\nCUSTOMER CONTEXT:\n${customer_context}`);
  }

  const prompt = layers.join("");

  // Cache key for Anthropic prompt caching — changes when any input changes
  const cacheKey = `persona:${persona_slug}:${tenant_id}:${tone_level}:${addendumVersion}`;

  return { prompt, cacheKey };
}
