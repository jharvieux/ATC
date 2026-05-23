// §14.2 — Commission state-machine.
//
// Allowed transitions per §14.2:
//   expected → invoiced, received, partial, overdue, disputed, waived
//   invoiced → received, partial, disputed, waived
//   received → partial, disputed, waived
//   partial  → received, disputed, waived
//   any state → disputed
//   any state → waived
//
// On every transition an audit_log row is written.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";

export type CommissionState =
  | "expected"
  | "invoiced"
  | "received"
  | "partial"
  | "overdue"
  | "disputed"
  | "waived";

export class InvalidCommissionTransitionError extends Error {
  constructor(
    public readonly from: CommissionState,
    public readonly to: CommissionState,
  ) {
    super(`Invalid commission state transition: ${from} → ${to}`);
    this.name = "InvalidCommissionTransitionError";
  }
}

const ALLOWED_TRANSITIONS: Record<CommissionState, ReadonlySet<CommissionState>> = {
  expected: new Set(["invoiced", "received", "partial", "overdue", "disputed", "waived"]),
  invoiced: new Set(["received", "partial", "disputed", "waived"]),
  received: new Set(["partial", "disputed", "waived"]),
  partial:  new Set(["received", "disputed", "waived"]),
  overdue:  new Set(["received", "partial", "invoiced", "disputed", "waived"]),
  disputed: new Set(["waived", "received", "partial"]),
  waived:   new Set([]), // terminal
};

export function assertValidTransition(from: CommissionState, to: CommissionState): void {
  if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
    throw new InvalidCommissionTransitionError(from, to);
  }
}

export async function transitionCommissionState(
  commissionId: string,
  to: CommissionState,
  meta: { actor_user_id?: string; reason?: string } = {},
): Promise<void> {
  const db = createServiceRoleClient();

  const { data: row, error: fetchError } = await db
    .from("commissions")
    .select("id, status")
    .eq("id", commissionId)
    .single();

  if (fetchError || !row) {
    throw new Error(`Commission ${commissionId} not found: ${fetchError?.message}`);
  }

  const from = (row as { status: CommissionState }).status;
  assertValidTransition(from, to);

  const { error: updateError } = await db
    .from("commissions")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", commissionId);

  if (updateError) {
    throw new Error(`Failed to transition commission ${commissionId}: ${updateError.message}`);
  }

  await writeAuditLog({
    actor_user_id: meta.actor_user_id ?? null,
    actor_type: meta.actor_user_id ? "user" : "system",
    action: "commission.state_transition",
    resource_type: "commission",
    resource_id: commissionId,
    changes: { from, to, reason: meta.reason ?? null },
  });
}
