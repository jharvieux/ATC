// §11.2 — Customer memory extraction Inngest job.
//
// ═══════════════════════════════════════════════════════════════
// MANDATORY SCOPE CONTRACT (§11.2.2):
//   tenant_id is sourced ONLY from event.data.tenant_id.
//   NEVER from a user lookup, a request header, or any derived field.
//   tenantClient(ctx) is used for EVERY DB call — the proxy auto-injects
//   the tenant_id filter as the primary defense against cross-tenant leaks.
//   The user_id assertion below is defense-in-depth: if the event payload
//   has a conversation that belongs to a different user, we fail loud.
// ═══════════════════════════════════════════════════════════════

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import { resolveAIBehavior } from "@/lib/personas/resolve-ai-behavior";
import { mergeMemory, type CustomerMemoryFields } from "@/lib/memory/merge";

// ── Zod schema for Haiku-extracted memory fields ─────────────────────────────

const LoyaltyProgramSchema = z.object({
  program_code: z.string(),
  member_number: z.string().optional(),
  tier: z.string().optional(),
});

const FamilyMemberSchema = z.object({
  name: z.string().optional(),
  relationship: z.string().optional(),
  date_of_birth: z.string().nullable().optional(),
  date_of_birth_is_estimated: z.boolean().optional(),
  estimation_basis: z.string().nullable().optional(),
  estimation_recorded_at: z.string().nullable().optional(),
  estimation_last_reprompt_at: z.string().nullable().optional(),
});

const ExtractedMemorySchema = z.object({
  preferences: z.record(z.unknown()).nullable().optional(),
  travel_history: z.record(z.unknown()).nullable().optional(),
  family_composition: z.array(FamilyMemberSchema).nullable().optional(),
  accessibility_needs: z.record(z.unknown()).nullable().optional(),
  dietary_restrictions: z.record(z.unknown()).nullable().optional(),
  loyalty_programs: z.array(LoyaltyProgramSchema).nullable().optional(),
  important_dates: z.record(z.unknown()).nullable().optional(),
  notes_freeform: z.string().nullable().optional(),
  rapport_tone_level: z.number().int().min(1).max(5).nullable().optional(),
  rapport_signals: z.record(z.unknown()).nullable().optional(),
}).partial();

// ── Step interface (matches Inngest step, mockable in tests) ──────────────────

export interface ExtractionStep {
  // T = any matches Inngest's step.run generic — safe because Inngest guarantees
  // the return type matches the fn return type at runtime.
  run<T = unknown>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<unknown>;
  sendEvent(id: string, events: unknown): Promise<unknown>;
}

// ── Anthropic client ──────────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    _anthropic = new Anthropic({ apiKey });
  }
  return _anthropic;
}

// ── Core extraction logic (exported for unit testing) ────────────────────────

export interface ExtractionInput {
  tenant_id: string;
  conversation_id: string;
  user_id: string;
  db: SupabaseClient;
  step: ExtractionStep;
}

export type ExtractionResult =
  | { status: "opted_out" }
  | { status: "background_ai_disabled" }
  | { status: "debounced"; last_extracted_at: string }
  | { status: "extraction_skipped_invalid_response" }
  | { status: "requeued_optimistic_lock_conflict" }
  | { status: "ok"; extracted_fields: string[] };

export async function runExtractMemory({
  tenant_id,
  conversation_id,
  user_id,
  db,
  step,
}: ExtractionInput): Promise<ExtractionResult> {
  // ── 1. Check memory_opt_out BEFORE any other read (§11.2 task 7) ──
  const { data: userRow, error: userErr } = await db
    .from("users")
    .select("memory_opt_out")
    .eq("id", user_id)
    .maybeSingle();

  if (userErr) throw new Error(`extract-memory: users fetch error — ${userErr.message}`);
  if (userRow?.memory_opt_out) return { status: "opted_out" };

  // ── 2. Check background_ai_enabled BEFORE debounce (§11.2 task 7) ──
  const { data: tenantRow, error: tenantErr } = await db
    .from("tenants")
    .select("ai_mode, background_ai_enabled")
    .eq("id", tenant_id)
    .maybeSingle();

  if (tenantErr) throw new Error(`extract-memory: tenants fetch error — ${tenantErr.message}`);
  if (!tenantRow) throw new Error(`extract-memory: tenant ${tenant_id} not found`);

  const flags = resolveAIBehavior({
    ai_mode: tenantRow.ai_mode as "autonomous" | "draft_only" | "disabled",
    background_ai_enabled: tenantRow.background_ai_enabled ?? false,
  });
  if (!flags.memory_extraction_enabled) return { status: "background_ai_disabled" };

  // ── 3. Defense-in-depth: verify conversation belongs to the claimed user ──
  const { data: conversation, error: convErr } = await db
    .from("conversations")
    .select("id, user_id, status")
    .eq("id", conversation_id)
    .maybeSingle();

  if (convErr) throw new Error(`extract-memory: conversation fetch error — ${convErr.message}`);
  if (!conversation) {
    throw new Error(
      `extract-memory: conversation ${conversation_id} not found ` +
        `(tenant filter applied — may be wrong tenant in event)`,
    );
  }

  // §11.2.2 defense-in-depth assertion.
  if (conversation.user_id !== user_id) {
    throw new Error(
      `extract-memory: SCOPE ASSERTION FAILED — ` +
        `event.data.user_id (${user_id}) !== conversation.user_id (${conversation.user_id}). ` +
        `This indicates a caller bug, not a missing row.`,
    );
  }

  // ── 4. Load or initialize the customer_memories row ──
  const { data: memoryRow, error: memErr } = await db
    .from("customer_memories")
    .select("*")
    .eq("user_id", user_id)
    .maybeSingle();

  if (memErr) throw new Error(`extract-memory: customer_memories fetch error — ${memErr.message}`);

  // ── 5. Debounce: skip if extracted recently (§11.2.3) ──
  const debounceSeconds = Number(process.env.MEMORY_EXTRACTION_DEBOUNCE_SECONDS ?? 120);
  if (memoryRow?.last_extracted_at) {
    const lastAt = new Date(memoryRow.last_extracted_at as string).getTime();
    const elapsedSeconds = (Date.now() - lastAt) / 1000;
    if (elapsedSeconds < debounceSeconds) {
      return { status: "debounced", last_extracted_at: memoryRow.last_extracted_at as string };
    }
  }

  // ── 6. Pull last N messages (§11.2.5) ──
  const messageWindow = Number(process.env.MEMORY_EXTRACTION_MESSAGE_WINDOW ?? 50);
  const { data: messages, error: msgErr } = await db
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(messageWindow);

  if (msgErr) throw new Error(`extract-memory: messages fetch error — ${msgErr.message}`);

  // ── 7. Haiku extraction call (wrapped in step.run for durability) ──
  const extracted = await step.run("haiku-extraction", async () => {
    const client = getAnthropicClient();

    const currentMemorySummary = memoryRow
      ? JSON.stringify({
          preferences: memoryRow.preferences,
          travel_history: memoryRow.travel_history,
          family_composition: memoryRow.family_composition,
          accessibility_needs: memoryRow.accessibility_needs,
          dietary_restrictions: memoryRow.dietary_restrictions,
          loyalty_programs: memoryRow.loyalty_programs,
          important_dates: memoryRow.important_dates,
          notes_freeform: memoryRow.notes_freeform,
          rapport_tone_level: memoryRow.rapport_tone_level,
          rapport_signals: memoryRow.rapport_signals,
        })
      : "{}";

    const transcript = (messages ?? [])
      .slice()
      .reverse()
      .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
      .join("\n");

    const prompt = `You are a travel concierge CRM assistant. Extract any new facts or updates about this customer from the conversation below.

Current known memory:
${currentMemorySummary}

Conversation (most recent ${messageWindow} messages):
${transcript}

Return a JSON object with only the fields that have new or updated information. Omit fields that are unchanged or unknown.
Valid fields: preferences, travel_history, family_composition, accessibility_needs, dietary_restrictions, loyalty_programs, important_dates, notes_freeform, rapport_tone_level (integer 1-5), rapport_signals.
loyalty_programs entries must include a "program_code" string key.
Return valid JSON only, no prose.`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      console.warn("[extract-memory] Haiku returned unparseable JSON", {
        rawText,
        conversation_id,
        tenant_id,
      });
      return null;
    }

    const result = ExtractedMemorySchema.safeParse(parsed);
    if (!result.success) {
      console.warn("[extract-memory] Haiku response failed Zod validation", {
        errors: result.error.issues,
        conversation_id,
        tenant_id,
      });
      return null;
    }

    return result.data;
  });

  if (!extracted) return { status: "extraction_skipped_invalid_response" };

  // ── 8. Merge extracted into current ──
  const current: CustomerMemoryFields = {
    preferences: (memoryRow?.preferences as CustomerMemoryFields["preferences"]) ?? null,
    travel_history: (memoryRow?.travel_history as CustomerMemoryFields["travel_history"]) ?? null,
    family_composition: (memoryRow?.family_composition as CustomerMemoryFields["family_composition"]) ?? null,
    accessibility_needs: (memoryRow?.accessibility_needs as CustomerMemoryFields["accessibility_needs"]) ?? null,
    dietary_restrictions: (memoryRow?.dietary_restrictions as CustomerMemoryFields["dietary_restrictions"]) ?? null,
    loyalty_programs: (memoryRow?.loyalty_programs as CustomerMemoryFields["loyalty_programs"]) ?? null,
    important_dates: (memoryRow?.important_dates as CustomerMemoryFields["important_dates"]) ?? null,
    notes_freeform: (memoryRow?.notes_freeform as string) ?? null,
    rapport_tone_level: (memoryRow?.rapport_tone_level as number) ?? null,
    rapport_signals: (memoryRow?.rapport_signals as CustomerMemoryFields["rapport_signals"]) ?? null,
  };

  const merged = mergeMemory(current, extracted as Partial<CustomerMemoryFields>);
  const now = new Date().toISOString();

  // ── 9. Optimistic-lock write (§11.2.4) ──
  if (memoryRow) {
    const currentUpdatedAt = memoryRow.updated_at as string;

    const { data: updateResult, error: updateErr } = await db
      .from("customer_memories")
      .update({ ...merged, last_extracted_at: now, updated_at: now })
      .eq("user_id", user_id)
      .eq("updated_at", currentUpdatedAt)
      .select("id");

    if (updateErr) throw new Error(`extract-memory: update error — ${updateErr.message}`);

    if (!updateResult || updateResult.length === 0) {
      const retryDelayMs = Number(process.env.MEMORY_EXTRACTION_RETRY_DELAY_MS ?? 5000);
      await step.sleep("optimistic-lock-retry-delay", retryDelayMs);
      await step.sendEvent("re-enqueue-extraction", {
        name: "conversation.memory_extract_requested",
        data: { tenant_id, conversation_id, user_id },
      });
      return { status: "requeued_optimistic_lock_conflict" };
    }
  } else {
    const { error: insertErr } = await db
      .from("customer_memories")
      .insert({
        user_id,
        ...merged,
        last_extracted_at: now,
        conversation_count: conversation.status === "closed" ? 1 : 0,
        updated_at: now,
      });

    if (insertErr) throw new Error(`extract-memory: insert error — ${insertErr.message}`);
  }

  return { status: "ok", extracted_fields: Object.keys(extracted) };
}

// ── Inngest function wrapper ──────────────────────────────────────────────────

export const extractMemory = inngest.createFunction(
  {
    id: "extract-memory",
    triggers: [{ event: "conversation.memory_extract_requested" }],
    retries: 3,
  },
  async ({ event, step }) => {
    // ── Mandatory scope contract: tenant_id from event payload ONLY ──
    // event.data is Record<string,unknown> in Inngest v4 untyped mode;
    // runtime safety guaranteed by the trigger event name match.
    const tenant_id = event.data.tenant_id as string;
    const conversation_id = event.data.conversation_id as string;
    const user_id = event.data.user_id as string;

    const ctx = tenantContextFromInngestEvent(
      event as { id: string; name: string; data: Record<string, unknown> },
    );
    const db = tenantClient(ctx);

    return runExtractMemory({ tenant_id, conversation_id, user_id, db, step: step as unknown as ExtractionStep });
  },
);
