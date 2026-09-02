// §18 — Hard-delete a group and its dependent rows. Service-role because the
// cleanup spans tables authenticated RLS doesn't grant DELETE/UPDATE on.
//
// CALLER CONTRACT: the caller MUST have already verified, via tenantClient (RLS)
// + the coordinator check, that `groupId` belongs to the caller's tenant and the
// caller is its coordinator. These queries filter by that verified id alone.

import "server-only";

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";

export async function hardDeleteGroup(groupId: string): Promise<void> {
  const svc = createServiceRoleClient();

  // invitations + forums (and their threads/messages) cascade via ON DELETE
  // CASCADE. Two inbound FKs do NOT cascade and are cleared first:
  //   email_log.related_group_id (nullable → null it, keep the audit row)
  //   group_invite_pending_approval.group_id (NOT NULL → delete the rows)
  await safeAwait(
    // d091-allow:service-role-tenant groupId pre-verified tenant+coordinator by the caller (see contract)
    svc.from("email_log").update({ related_group_id: null }).eq("related_group_id", groupId),
    "groups.delete.unlink_email_log",
  );
  await safeAwait(
    // d091-allow:service-role-tenant groupId pre-verified tenant+coordinator by the caller (see contract)
    svc.from("group_invite_pending_approval").delete().eq("group_id", groupId),
    "groups.delete.pending_approval",
  );
  // d091-allow:service-role-tenant groupId pre-verified tenant+coordinator by the caller (see contract)
  await safeAwait(svc.from("groups").delete().eq("id", groupId), "groups.delete");
}
