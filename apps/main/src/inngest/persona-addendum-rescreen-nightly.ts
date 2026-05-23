// §16.6 — Nightly re-screen of all approved persona addendums.
// Catches model improvements + newly-discovered adversarial patterns.
// Runs daily at 04:00 UTC.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { screenAddendumHaiku } from "@/lib/personas/screen-addendum-haiku";
import { writeAuditLog } from "@/lib/audit/write";

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
      return;
    }

    let reviewed = 0;
    let suspended = 0;

    for (const row of (rows ?? []) as { id: string; tenant_id: string; persona_slug: string; content: string }[]) {
      reviewed++;
      try {
        const result = await screenAddendumHaiku(row.content, { tenant_id: row.tenant_id });

        if (result.pass) {
          await db
            .from("persona_addendums")
            .update({
              haiku_screen_result: result as unknown as Record<string, unknown>,
              haiku_screened_at: new Date().toISOString(),
            })
            .eq("id", row.id);
        } else {
          await db
            .from("persona_addendums")
            .update({
              haiku_screen_result: result as unknown as Record<string, unknown>,
              haiku_screened_at: new Date().toISOString(),
              status: "suspended",
              updated_at: new Date().toISOString(),
            })
            .eq("id", row.id);
          suspended++;
          // TODO(notifications): email tenant with §16.6 suspension explanation.
          await writeAuditLog({
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: "persona_addendum.suspended_on_rescreen",
            resource_type: "persona_addendum",
            resource_id: row.id,
            changes: { persona_slug: row.persona_slug, findings_count: result.findings.length },
          });
          console.warn(
            "[persona-addendum-rescreen-nightly] SUSPENDED tenant=%s persona=%s findings=%d",
            row.tenant_id, row.persona_slug, result.findings.length,
          );
        }
      } catch (e) {
        console.error("[persona-addendum-rescreen-nightly] error addendum=%s: %s", row.id, e);
      }
    }

    console.info("[persona-addendum-rescreen-nightly] reviewed=%d suspended=%d", reviewed, suspended);
    return { reviewed, suspended };
  },
);
