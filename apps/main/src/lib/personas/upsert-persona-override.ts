// §9.3 / §9.5 — Persona override upsert with tier-gating and Haiku screening
// Tier gating (enforced here, not in SQL):
//   display_name_override: blocked for byo_research
//   system_prompt_addendum: blocked for any non-agency tier
//   system_prompt_addendum: blocked when background_ai_enabled=false

import type { SupabaseClient } from "@supabase/supabase-js";
import { screenPersonaAddendum } from "./screen-addendum";

// Tiers that may set display_name_override (all except byo_research)
const ALLOW_DISPLAY_NAME_OVERRIDE_TIERS = new Set([
  "byo_professional",
  "byo_agency",
  "sub_starter",
  "sub_pro",
  "sub_agency",
]);

// Tiers that may set system_prompt_addendum (agency only per §9.3)
const ALLOW_ADDENDUM_TIERS = new Set(["sub_agency", "byo_agency"]);

export type PersonaOverrideInput = {
  display_name_override?: string | null;
  system_prompt_addendum?: string | null;
  is_disabled?: boolean;
};

export type UpsertPersonaOverrideResult =
  | { ok: true; id: string }
  | { ok: false; error: string }
  | { ok: false; error: string; reasons: string[] };

type TenantInfo = {
  id: string;
  tier: string;
  background_ai_enabled: boolean;
};

export async function upsertPersonaOverride(
  tenant: TenantInfo,
  persona_slug: string,
  input: PersonaOverrideInput,
  // tenantClient(ctx) from the caller — auto-scopes the upsert to the tenant.
  db: SupabaseClient,
): Promise<UpsertPersonaOverrideResult> {
  // Tier gate: display_name_override
  if (input.display_name_override != null && !ALLOW_DISPLAY_NAME_OVERRIDE_TIERS.has(tenant.tier)) {
    return {
      ok: false,
      error: "display_name_override is not available for byo_research tier",
    };
  }

  // Tier gate: system_prompt_addendum
  if (input.system_prompt_addendum != null) {
    if (!ALLOW_ADDENDUM_TIERS.has(tenant.tier)) {
      return {
        ok: false,
        error: "system_prompt_addendum requires an agency tier (sub_agency or byo_agency)",
      };
    }

    // Background AI gate: addendum screening cannot run when background AI is off
    if (!tenant.background_ai_enabled) {
      return {
        ok: false,
        error: "system_prompt_addendum cannot be saved when background_ai_enabled is false",
      };
    }

    // Haiku safety screening per §9.3
    const screening = await screenPersonaAddendum(input.system_prompt_addendum);
    if (!screening.approved) {
      return {
        ok: false,
        error: "system_prompt_addendum failed safety screening",
        reasons: screening.reasons,
      } as { ok: false; error: string; reasons: string[] };
    }
  }

  const { data, error } = await db
    .from("tenant_persona_overrides")
    .upsert(
      {
        tenant_id: tenant.id,
        persona_slug,
        ...(input.display_name_override !== undefined
          ? { display_name_override: input.display_name_override }
          : {}),
        ...(input.system_prompt_addendum !== undefined
          ? { system_prompt_addendum: input.system_prompt_addendum }
          : {}),
        ...(input.is_disabled !== undefined ? { is_disabled: input.is_disabled } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,persona_slug" },
    )
    .select("id")
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id: data.id };
}
