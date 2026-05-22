// §15.7 — Onboarding Stage 6: State of operation + compliance attestation.
// Phase 0/1: single state-of-operation field only.
// Phase 2 attorney gate (Seller of Travel per-state branching): deferred.

import { assertPermission } from "@/lib/auth/assert-permission";
import { progressTo } from "@/lib/onboarding/state-machine";
import { tenantClient } from "@/lib/db/tenant-client";

const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP",
]);

interface StateOfOperationBody {
  state_of_operation: string;
  // User must have clicked through the host-agency notice per §15.7.
  confirmed_host_agency_notice: boolean;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "onboarding", action: "state_of_operation:submit" });

    let body: StateOfOperationBody;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const state = body.state_of_operation?.toUpperCase();
    if (!state || !US_STATE_CODES.has(state)) {
      return Response.json({ error: "invalid_state_code" }, { status: 422 });
    }

    if (!body.confirmed_host_agency_notice) {
      return Response.json({ error: "must_confirm_host_agency_notice" }, { status: 422 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("tenants")
      .update({ state_of_operation: state })
      .eq("id", ctx.tenant_id);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    await progressTo(ctx.tenant_id, "tier_select");

    return Response.json({ ok: true, next_stage: "tier_select" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
