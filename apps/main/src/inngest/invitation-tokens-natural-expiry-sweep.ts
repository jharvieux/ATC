// §18.9 — Nightly sweep for naturally-expired invitation tokens.
//
// "Natural expiry … set on next access or by nightly cron, whichever first."
// This job is the backup for tokens no one has accessed since expiry.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const invitationTokensNaturalExpirySweep = inngest.createFunction(
  {
    id: "invitation-tokens-natural-expiry-sweep",
    triggers: [{ cron: "0 3 * * *" }], // 03:00 UTC daily
  },
  async () => {
    const svc = createServiceRoleClient();

    // Groups whose sailing_date + 30 days has passed.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    const { data: oldGroups, error: groupErr } = await svc
      .from("groups")
      .select("id")
      .lt("sailing_date", cutoffDate);

    if (groupErr) {
      console.error("[invitation-tokens-natural-expiry-sweep] group query error:", groupErr.message);
      return { swept: 0 };
    }

    const groupIds = (oldGroups ?? []).map((g: { id: string }) => g.id);
    if (groupIds.length === 0) return { swept: 0 };

    const { data: updated, error: updateErr } = await svc
      .from("invitations")
      .update({ token_revoked_at: new Date().toISOString(), token_revoked_reason: "expired_natural" })
      .in("group_id", groupIds)
      .is("token_revoked_at", null)
      .select("id");

    if (updateErr) {
      console.error("[invitation-tokens-natural-expiry-sweep] update error:", updateErr.message);
      return { swept: 0 };
    }

    const swept = updated?.length ?? 0;
    console.log(`[invitation-tokens-natural-expiry-sweep] swept=${swept}`);
    return { swept };
  },
);
