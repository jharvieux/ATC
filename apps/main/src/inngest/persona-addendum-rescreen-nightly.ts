// §16.6 — Nightly re-screen of all approved persona addendums.
// Catches model improvements + newly-discovered adversarial patterns.
// Runs daily at 04:00 UTC.
//
// §27.12 batch migration: this function used to call Haiku synchronously
// per addendum. It now ENQUEUES one batch request per approved row via
// the §27.12 batch pipeline. A new consumer
// (`personaAddendumRescreenFromBatchResult`) handles the
// suspend-on-fail + notification + audit when each row's result lands.
//
// Why a separate purpose from `persona_addendum_screen`:
//   The pass/fail semantics differ. On the initial screen,
//   pass→approved + fail→rejected (a freshly-submitted addendum is in
//   "pending"). On rescreen, the row is already "approved" so the only
//   action is to suspend (or no-op on pass). Different downstream
//   behavior = different purpose, separate consumer + flush cron.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeHtml } from "@/lib/utils";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { safeAwait } from "@/lib/db/safe-mutation";
import { enqueueBatchRequest } from "@/lib/ai/batch/enqueue";
import { HAIKU_MODEL, SCREENING_SYSTEM_PROMPT, parseScreenResult } from "./persona-addendum-screen";
import { mapWithConcurrency } from "@/lib/async/with-concurrency";

// #1789 — each addendum's enqueue is an independent DB insert (no Anthropic
// call happens here — the batch flush cron submits to Anthropic separately).
const ENQUEUE_CONCURRENCY = 20;

const RescreenBatchResultPayloadSchema = z.object({
  tenant_id: z.string(),
  result_text: z.string(),
  caller_metadata: z.object({
    tenant_id: z.string(),
    addendum_id: z.string(),
    persona_slug: z.string(),
  }).nullable(),
});

// ── Producer ─────────────────────────────────────────────────────────────────

export const personaAddendumRescreenNightly = inngest.createFunction(
  {
    id: "persona-addendum-rescreen-nightly",
    triggers: [{ cron: "0 4 * * *" }],
  },
  async () => {
    const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("persona_addendums")
      .select("id, tenant_id, persona_slug, content")
      .eq("status", "approved");

    if (error) {
      console.error("[persona-addendum-rescreen-nightly] fetch failed: %s", error.message);
      return { enqueued: 0, error: error.message };
    }

    const approved = (rows ?? []) as Array<{
      id: string;
      tenant_id: string;
      persona_slug: string;
      content: string;
    }>;

    const outcomes = await mapWithConcurrency(approved, ENQUEUE_CONCURRENCY, async (row) => {
      try {
        await enqueueBatchRequest({
          tenant_id: row.tenant_id,
          purpose: "persona_addendum_rescreen",
          request_params: {
            model: HAIKU_MODEL,
            max_tokens: 1024,
            system: SCREENING_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `Screen the following persona addendum:\n\n---\n${row.content}\n---`,
              },
            ],
          },
          caller_metadata: {
            tenant_id: row.tenant_id,
            addendum_id: row.id,
            persona_slug: row.persona_slug,
          },
          db,
        });
        return true;
      } catch (e) {
        console.error(
          "[persona-addendum-rescreen-nightly] enqueue failed addendum=%s: %s",
          row.id,
          e instanceof Error ? e.message : String(e),
        );
        return false;
      }
    });
    const enqueued = outcomes.filter(Boolean).length;

    console.info("[persona-addendum-rescreen-nightly] enqueued=%d total_approved=%d", enqueued, approved.length);
    return { enqueued, total_approved: approved.length };
  },
);

// ── Consumer ─────────────────────────────────────────────────────────────────
//
// Fires per row when the reconciler completes a persona_addendum_rescreen batch.
// On pass: update screened_at + cached result (status stays "approved").
// On fail: suspend the row, email tenant owners, audit-log.

export interface ApplyRescreenInput {
  db: SupabaseClient;
  tenant_id: string;
  addendum_id: string;
  persona_slug: string;
  result_text: string;
}

export type ApplyRescreenResult =
  | { status: "approved"; findings_count: 0 }
  | { status: "suspended"; findings_count: number };

export async function applyRescreenResult({
  db,
  tenant_id,
  addendum_id,
  persona_slug,
  result_text,
}: ApplyRescreenInput): Promise<ApplyRescreenResult> {
  const result = parseScreenResult(result_text);

  if (result.pass) {
    await safeAwait(
      db
        .from("persona_addendums")
        .update({
          haiku_screen_result: result as unknown as Record<string, unknown>,
          haiku_screened_at: new Date().toISOString(),
        })
        .eq("id", addendum_id),
      "persona_addendums.update",
    );
    return { status: "approved", findings_count: 0 };
  }

  // Suspend on fail (different from initial screen which rejects).
  await safeAwait(
    db
      .from("persona_addendums")
      .update({
        haiku_screen_result: result as unknown as Record<string, unknown>,
        haiku_screened_at: new Date().toISOString(),
        status: "suspended",
        updated_at: new Date().toISOString(),
      })
      .eq("id", addendum_id),
    "persona_addendums.update",
  );

  try {
    const { data: owners } = await db
      .from("users")
      .select("email")
      .eq("tenant_id", tenant_id)
      .eq("status", "active");
    const recipients = ((owners ?? []) as Array<{ email: string }>).map((u) => u.email);
    if (recipients.length > 0) {
      const { sendTenantNotification } = await import("@/lib/email/notifications");
      const findingsList = result.findings
        .map((f) => `<li><strong>${f.category}:</strong> ${escapeHtml(f.evidence)}</li>`)
        .join("");
      const html = `<h2>Persona addendum suspended</h2>
        <p>The nightly rescreen flagged your <strong>${persona_slug}</strong> addendum
        for policy concerns. It has been suspended pending review.</p>
        <ul>${findingsList}</ul>
        <p>Please revise and resubmit from your tenant settings, or contact support.</p>`;
      for (const to of recipients) {
        await sendTenantNotification({
          db,
          tenant_id,
          to,
          subject: "Persona addendum suspended",
          html,
          category: "transactional",
          template_id: "persona_addendum_suspended",
        });
      }
    }
  } catch (notifyErr) {
    console.warn(
      "[persona-addendum-rescreen:consumer] notification failed: %s",
      notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
    );
  }

  await writeAuditLog({
    tenant_id,
    actor_type: "system",
    action: "persona_addendum.suspended_on_rescreen",
    resource_type: "persona_addendum",
    resource_id: addendum_id,
    changes: { persona_slug, findings_count: result.findings.length },
  });

  console.warn(
    "[persona-addendum-rescreen:consumer] SUSPENDED tenant=%s persona=%s findings=%d",
    tenant_id,
    persona_slug,
    result.findings.length,
  );
  return { status: "suspended", findings_count: result.findings.length };
}

export const personaAddendumRescreenFromBatchResult = inngest.createFunction(
  {
    id: "persona-addendum-rescreen-from-batch-result",
    triggers: [{ event: "ai.batch_request.completed.persona_addendum_rescreen" }],
  },
  async ({ event }) => {
    const parsed = RescreenBatchResultPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[persona-addendum-rescreen:consumer] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const { tenant_id, result_text, caller_metadata } = parsed.data;
    if (!caller_metadata) {
      console.error("[persona-addendum-rescreen:consumer] missing caller_metadata");
      return { error: "missing_caller_metadata" };
    }
    const { addendum_id, persona_slug } = caller_metadata;
    const db = createServiceRoleClient();

    const outcome = await applyRescreenResult({
      db,
      tenant_id,
      addendum_id,
      persona_slug,
      result_text,
    });
    return { addendum_id, ...outcome };
  },
);
