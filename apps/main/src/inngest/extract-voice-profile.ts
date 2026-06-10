// #903 / D-193 — Voice-profile style-card extraction.
//
// INNGEST-PROBE-ALLOW-MIXED: tenantClient fetches voice_samples (RLS-scoped to
// the tenant from event.data.tenant_id). service-role is used ONLY for
// voice_profiles upsert/delete — those have RLS UPDATE=true (tenant-scoped) but
// DELETE=false (service-role only by design, same as rag_submissions). The two
// DB surfaces don't overlap; no cross-tenant read is possible.
//
// Event-driven (no cron; idle = free per D-192 cost posture).
// Triggered by "voice_profile.extraction_requested" events dispatched by
// the sample CRUD API when samples are added or deleted.
//
// Hash guard: if the sorted sample bodies haven't changed since the last
// extraction, we skip the Anthropic call. This prevents re-billing when
// the TA loads the settings page and re-saves identical text.

import { createHash } from "node:crypto";
import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";
import { safeAwait } from "@/lib/db/safe-mutation";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const EXTRACTION_SYSTEM_PROMPT = `You are a writing-style analyst. A travel agent has shared sample emails they sent to clients.
Extract a compact style card describing how they write. Return ONLY a JSON object with these keys:
- greeting: their typical greeting pattern (e.g. "Hi {first}," or "Dear {full_name},")
- signoff: their typical sign-off (e.g. "Best," or "Safe travels,")
- formality: one of "formal" | "professional" | "friendly" | "casual"
- rhythm: one sentence describing sentence length and flow
- signature_phrases: up to 3 characteristic phrases they reuse (array of strings)
- emoji_habits: "none" | "occasional" | "frequent"
- bad_news: one sentence on how they soften difficult news (e.g. price changes, unavailability)
Return only valid JSON, no explanation.`;

// ── Core extraction logic (exported for unit testing) ────────────────────────
// Mirrors the extract-memory pattern: the Inngest wrapper handles event
// binding and payment gate; this function owns the business logic.

export interface ExtractVoiceProfileInput {
  tenant_id: string;
  user_id: string | null;
  db: ReturnType<typeof tenantClient>;
  svc: ReturnType<typeof createServiceRoleClient>;
}

// Return type for the testable helper — excludes payment-gate outcomes (those
// are handled by the Inngest wrapper before this function is called).
export type ExtractVoiceProfileResult =
  | { status: "no_samples" }
  | { status: "unchanged" }
  | { status: "extracted"; samples: number };

export async function runExtractVoiceProfile(
  input: ExtractVoiceProfileInput,
): Promise<ExtractVoiceProfileResult> {
  const { tenant_id, user_id, db, svc } = input;

  const samplesBase = db.from("voice_samples").select("body").order("created_at", { ascending: true });
  const samplesQ = user_id === null ? samplesBase.is("user_id", null) : samplesBase.eq("user_id", user_id);
  const { data: rows, error: samplesErr } = await samplesQ;
  if (samplesErr) throw new Error(`voice_samples fetch failed: ${samplesErr.message}`);

  const samples = (rows ?? []).map((r) => (r as { body: string }).body);
  if (samples.length === 0) {
    await safeAwait(
      (user_id === null
        ? svc.from("voice_profiles").delete().eq("tenant_id", tenant_id).is("user_id", null)
        : svc.from("voice_profiles").delete().eq("tenant_id", tenant_id).eq("user_id", user_id)),
      "voice_profiles.delete.no_samples",
    );
    return { status: "no_samples" };
  }

  const sorted = [...samples].sort();
  const hash = createHash("sha256").update(sorted.join("\n---\n")).digest("hex");

  const existingBase = svc.from("voice_profiles").select("id, samples_hash").eq("tenant_id", tenant_id);
  const { data: existing, error: existErr } = await (
    user_id === null ? existingBase.is("user_id", null) : existingBase.eq("user_id", user_id)
  ).maybeSingle();
  if (existErr) throw new Error(`voice_profiles fetch failed: ${existErr.message}`);

  const existingHash = (existing as { samples_hash: string } | null)?.samples_hash ?? "";
  if (hash === existingHash) {
    return { status: "unchanged" };
  }
  const existingId = (existing as { id: string } | null)?.id ?? null;

  const userContent = `Here are ${samples.length} email sample(s) from this travel agent:\n\n${
    samples.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join("\n\n")
  }`;

  const result = await instrumentedClaudeCall({
    tenant_id,
    model: HAIKU_MODEL,
    purpose: "other",
    max_tokens: 512,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  let style_card: Record<string, unknown> = {};
  try {
    const clean = result.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    style_card = JSON.parse(clean) as Record<string, unknown>;
  } catch {
    style_card = { raw: result.text };
  }

  const now = new Date().toISOString();
  if (existingId) {
    // d091-allow:service-role-tenant — scoped to .eq("id", existingId) which was
    // loaded with .eq("tenant_id", tenant_id) above (event scope contract).
    await safeAwait(
      svc.from("voice_profiles")
        .update({ style_card, samples_hash: hash, extracted_at: now })
        .eq("id", existingId).eq("tenant_id", tenant_id),
      "voice_profiles.update",
    );
  } else {
    await safeAwait(
      svc.from("voice_profiles")
        .insert({ tenant_id, user_id, style_card, samples_hash: hash, extracted_at: now }),
      "voice_profiles.insert",
    );
  }

  return { status: "extracted", samples: samples.length };
}

// ── Inngest function wrapper ──────────────────────────────────────────────────

export const extractVoiceProfile = inngest.createFunction(
  {
    id: "extract-voice-profile",
    triggers: [{ event: "voice_profile.extraction_requested" }],
    retries: 2,
  },
  async ({ event }) => {
    const tenant_id = event.data.tenant_id as string;
    const user_id = (event.data.user_id as string | null) ?? null;

    const ctx = tenantContextFromInngestEvent(
      event as { id: string; name: string; data: Record<string, unknown> },
    );
    const db = tenantClient(ctx);
    const svc = createServiceRoleClient();

    const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
    if (!paymentCheck.ok) {
      console.info("[extract-voice-profile] skipping past-grace tenant", { tenant_id, user_id });
      return { status: "skipped_payment" };
    }

    return runExtractVoiceProfile({ tenant_id, user_id, db, svc });
  },
);
