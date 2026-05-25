// §16.6 — Persona addendum screening Inngest job.
// Triggered on every save (initial + edits). Re-screens via Haiku and writes
// the result back to persona_addendums.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { screenAddendumHaiku } from "@/lib/personas/screen-addendum-haiku";
import { writeAuditLog } from "@/lib/audit/write";
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";

interface ScreenPayload {
  tenant_id: string;
  persona_slug: string;
  addendum_id: string;
}

export const personaAddendumScreen = inngest.createFunction(
  {
    id: "persona-addendum-screen",
    triggers: [{ event: "persona_addendum.submitted" }],
  },
  async ({ event }) => {
    const { addendum_id } = event.data as ScreenPayload;
    const db = createServiceRoleClient();

    const { data: row, error } = await db
      .from("persona_addendums")
      .select("id, content, status, tenant_id")
      .eq("id", addendum_id)
      .maybeSingle();

    if (error || !row) {
      console.error("[persona-addendum-screen] addendum not found: %s", addendum_id);
      return { error: "addendum_not_found" };
    }

    const a = row as { id: string; content: string; status: string; tenant_id: string };

    // §15.16 — Don't burn Haiku spend screening a past-grace tenant's
    // addendum. The addendum stays in 'pending' status; if they resume
    // paying, a manual rescreen via the admin UI catches it up.
    const paymentCheck = await assertTenantStillPayingById(db, a.tenant_id);
    if (!paymentCheck.ok) {
      console.info("[persona-addendum-screen] skipping past-grace tenant",
        { tenant_id: a.tenant_id, addendum_id, reason: paymentCheck.reason });
      return { skipped: true, reason: paymentCheck.reason };
    }

    const result = await screenAddendumHaiku(a.content, { tenant_id: a.tenant_id });

    const newStatus = result.pass ? "approved" : "rejected";

    await db
      .from("persona_addendums")
      .update({
        haiku_screen_result: result as unknown as Record<string, unknown>,
        haiku_screened_at: new Date().toISOString(),
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("id", a.id);

    // TODO(notifications): on rejected, email tenant with findings summary.
    await writeAuditLog({
      tenant_id: a.tenant_id,
      actor_type: "system",
      action: "persona_addendum.screened",
      resource_type: "persona_addendum",
      resource_id: a.id,
      changes: { status: newStatus, findings_count: result.pass ? 0 : result.findings.length },
    });
    console.info(
      "[persona-addendum-screen] addendum=%s status=%s findings=%d",
      a.id, newStatus, result.pass ? 0 : result.findings.length,
    );

    return { addendum_id: a.id, status: newStatus, findings_count: result.pass ? 0 : result.findings.length };
  },
);
