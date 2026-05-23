// §26.5a — Set or clear the legal_hold flag on a forensics_log row.
// Must be called inside withPlatformAdminAudit.

import { platformAdminClient } from "@/lib/db/platform-admin-client";

export async function setLegalHold(
  snapshot_id: string,
  hold: boolean,
  reason: string,
): Promise<void> {
  if (!reason || reason.trim().length === 0) {
    throw new Error("setLegalHold: reason is required (captured in audit_log via withPlatformAdminAudit).");
  }
  const db = platformAdminClient();
  const { error } = await db
    .from("forensics_log")
    .update({ legal_hold: hold })
    .eq("id", snapshot_id);
  if (error) throw new Error(`setLegalHold failed: ${error.message}`);
}
