// §20.9 — Booking modification via host adapter.
//
// POST /api/bookings/:id/modify
//   Body: { field: string, new_value: unknown, reason?: string }
//
// The adapter's capabilities.supports_modification flag gates availability.
// If the adapter doesn't support modification, returns a structured 409 error.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { selectAdapterForCall } from "@/lib/host-adapters/select-adapter";
import type { ModificationRequest } from "@atc/shared-types";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings", action: "modify" });
    const svc = createServiceRoleClient();
    const { id: bookingId } = await params;

    const { data: booking } = await svc
      .from("bookings")
      .select("id, tenant_id, status, provider_booking_ref, host_adapter")
      .eq("id", bookingId)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (!booking) return Response.json({ error: "booking_not_found" }, { status: 404 });

    const bookingRow = booking as { id: string; tenant_id: string; status: string; provider_booking_ref: string | null; host_adapter: string | null };

    if (!["confirmed"].includes(bookingRow.status)) {
      return Response.json({ error: "booking_not_modifiable", status: bookingRow.status }, { status: 409 });
    }

    const body = await req.json() as { field?: string; new_value?: unknown; reason?: string };
    if (!body.field || body.new_value === undefined) {
      return Response.json({ error: "field_and_new_value_required" }, { status: 400 });
    }

    // Fail CLOSED on tenant read — never default sandbox to false on error
    // (would let a sandboxed tenant's modify reach a real host adapter).
    const { data: tenantRow, error: tenantErr } = await svc
      .from("tenants")
      // #1190: column is tenant_type, not prong (prong was never a column).
      .select("tenant_type, is_sandbox")
      .eq("id", ctx.tenant_id)
      .single();

    if (tenantErr || !tenantRow) {
      return Response.json(
        { error: "tenant_lookup_failed", detail: tenantErr?.message ?? "no row" },
        { status: 500 },
      );
    }

    const tenantForAdapter = tenantRow as { tenant_type: string; is_sandbox: boolean };

    const correlation_id = crypto.randomUUID();
    const { adapter, ctx: hostCtx } = await selectAdapterForCall(
      {
        id: ctx.tenant_id,
        prong: tenantForAdapter.tenant_type,
        is_sandbox: tenantForAdapter.is_sandbox,
      },
      { tenant_id: ctx.tenant_id, user_id: null, correlation_id },
    );

    // Check modification capability
    if (!adapter.capabilities.supports_modification) {
      return Response.json({
        error: "adapter_does_not_support_modification",
        adapter: adapter.adapterId,
      }, { status: 409 });
    }

    const modReq: ModificationRequest = {
      field: body.field,
      new_value: body.new_value,
      ...(body.reason !== undefined && { reason: body.reason }),
    };

    const result = await adapter.modifyBooking(
      bookingRow.provider_booking_ref ?? bookingId,
      modReq,
      hostCtx,
    );

    if (!result.ok) {
      return Response.json({ error: result.error.message ?? "adapter_modify_failed", code: result.error.code }, { status: 502 });
    }

    // D-091 Pattern 5 — service-role bypasses RLS. Add tenant_id filter for
    // defense-in-depth: a request that smuggles in another tenant's bookingId
    // is still scoped to ctx.tenant_id at the DB layer.
    await safeAwait(
      svc.from("bookings")
        .update({ status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", bookingId)
        .eq("tenant_id", ctx.tenant_id),
      "bookings.update",
    );

    return Response.json({ ok: true, adapter_response: result.value });
  } catch (err) {
    return respondToAuthError(err);
  }
}
