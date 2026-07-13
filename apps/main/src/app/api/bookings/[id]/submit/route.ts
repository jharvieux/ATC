// §14.3 / §14.4 — Booking submission with commission rate resolution.
//
// Fail-closed contract per §14.4:
//   - commission_rate unresolvable → no commissions row, booking → pending_host_review
//   - platform_split_rate unresolvable → same
//   - Both cases: alert platform admin via audit log, surface copy to tenant
//
// Commission computation order per §14.3 "Computation" (NOT multiply by (1 - rate)):
//   gross_commission_cents = multiplyRate(commissionable_fare_cents, commission_rate)
//   net_commission_cents   = subtractFee(gross_commission_cents, host_booking_fee_cents)
//   platform_retained_cents = multiplyRate(net_commission_cents, platform_split_rate)
//   subhost_payable_cents   = subtractFee(net_commission_cents, platform_retained_cents)
//
// #1777 — submitBooking() below orchestrates the pipeline as a sequence of named
// steps (load+lock → DOB gate → tenant/split → adapter/rate → rate gate →
// commission compute → quote pricing → host dispatch → persist+commit → side
// effects). The draft→submitting lock is reverted ONLY on the pre-host-call
// failure steps (DOB gate, tenant lookup, host dispatch), each via the single
// revertSubmitLock helper; post-host failures route to pending_host_review and
// MUST NOT revert (see #1577). Keeping each step small confines the
// "did this branch forget to revert?" question to a few lines instead of 499.

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { selectAdapterForCall } from "@/lib/host-adapters/select-adapter";
import { dollarsToCents, multiplyRate, subtractFee, toRate, type Cents } from "@/lib/money";
import { writeAuditLog } from "@/lib/audit/write";
import type { BookingSubmissionRequest } from "@atc/shared-types";
import { safeAwait } from "@/lib/db/safe-mutation";
import { withIdempotencyKey } from "@/lib/http/idempotency";
import { dbErrorResponse } from "@/lib/api/db-error-response";

type BookingRow = {
  id: string;
  tenant_id: string;
  status: string;
  host_adapter: string | null;
  commissionable_fare_cents: bigint | null;
  total_amount_cents: bigint | null;
  currency: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  primary_contact_id: string | null;
};

type TenantRow = {
  id: string;
  tenant_type: string;
  tier_id: string | null;
  is_sandbox: boolean;
};

type TierRow = {
  id: string;
  platform_split_rate: number | null;
  hold_period_days: number;
};

// #1190: real columns are host_adapter / flat_fee_amount / percent_of_commission
// / id. flat_fee_amount + percent_of_commission are NUMERIC, returned as strings.
type FeeConfigRow = {
  id: string;
  fee_type: string;
  flat_fee_amount: number | string | null;
  percent_of_commission: number | string | null;
};

type Db = ReturnType<typeof tenantClient>;
type AdminDb = ReturnType<typeof createServiceRoleClient>;
type SelectedAdapter = Awaited<ReturnType<typeof selectAdapterForCall>>;

// §14.3 commission money bundle, computed once and threaded into the commit RPC.
type CommissionComputation = {
  fare: Cents;
  gross_commission_cents: Cents;
  host_booking_fee_cents: Cents;
  host_booking_fee_rule_ref: string | null;
  net_commission_cents: Cents;
  platform_retained_cents: Cents;
  subhost_payable_cents: Cents;
};

// §12.6 host booking fee, locked at submission (§14.3). `flat` is a dollar
// amount (NUMERIC dollars → cents via dollarsToCents); `percent` is a fraction OF THE GROSS
// COMMISSION (not the fare). `none` → 0. `tiered` + minimum_commission_threshold
// are not yet implemented (#1247) and also resolve to 0 here. ruleRef snapshots
// which config/override row was applied, for auditable re-derivation.
function resolveHostFeeCents(
  fee: FeeConfigRow,
  grossCommissionCents: Cents,
): { cents: Cents; ruleRef: string | null } {
  let cents = 0n as Cents;
  if (fee.fee_type === "flat" && fee.flat_fee_amount != null) {
    cents = dollarsToCents(fee.flat_fee_amount);
  } else if (fee.fee_type === "percent" && fee.percent_of_commission != null) {
    cents = multiplyRate(grossCommissionCents, toRate(Number(fee.percent_of_commission)));
  }
  return { cents, ruleRef: fee.id };
}

// #1577 — release the draft→submitting CAS lock by reverting to 'draft'. Only
// safe on PRE-host-call exits (DOB gate, tenant lookup): once the host adapter
// has been called we must NOT revert to a re-submittable state (see the sweep
// and the commission-write-failed path, which route to pending_host_review).
// The .eq("status","submitting") guard makes this a no-op if a concurrent path
// already moved the row on.
async function revertSubmitLock(db: Db, bookingId: string, label: string): Promise<void> {
  await safeAwait(
    db
      // d091-allow:service-role-tenant — db is tenantClient(ctx), RLS-scoped to ctx.tenant_id; not a service-role write.
      .from("bookings")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", bookingId)
      .eq("status", "submitting"),
    label,
  );
}

// Step 1 — load the booking (404 if missing, 422 if not draft) and acquire the
// D-091 Round-3 #51 CAS lock (draft → submitting) so concurrent submits can't
// both reach the host adapter call. 0 rows matched → another submit holds the
// lock → 409. Nothing to revert on any of these exits: the lock isn't held yet.
// If the process later dies mid-flight the bookings-stuck-submitting-reconcile
// cron routes the stuck row to 'pending_host_review' (reason 'host_state_unknown'),
// NEVER back to 'draft', because it cannot prove no live host booking exists (#1577).
async function loadAndLockBooking(
  db: Db,
  bookingId: string,
): Promise<{ response: Response } | { booking: BookingRow }> {
  const { data: bookingData, error: bookingError } = await db
    .from("bookings")
    .select(
      "id, tenant_id, status, host_adapter, commissionable_fare_cents, total_amount_cents, currency, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, primary_contact_id",
    )
    .eq("id", bookingId)
    .single();

  if (bookingError || !bookingData) {
    return { response: Response.json({ error: "Booking not found." }, { status: 404 }) };
  }
  const booking = bookingData as BookingRow;
  if (booking.status !== "draft") {
    return { response: Response.json({ error: "Only draft bookings can be submitted." }, { status: 422 }) };
  }

  const { data: lockRows } = await db
    .from("bookings")
    .update({ status: "submitting", updated_at: new Date().toISOString() })
    .eq("id", bookingId)
    .eq("status", "draft")
    .select("id");
  if (!lockRows || (lockRows as Array<{ id: string }>).length === 0) {
    return {
      response: Response.json(
        { error: "Booking submission already in flight or status changed." },
        { status: 409 },
      ),
    };
  }
  return { booking };
}

// Step 2 — §20.5 DOB confirmation gate, must clear before the host adapter call.
// Pre-host exit: release the lock so the agent can resubmit after resolving DOBs
// (#1577). Non-DOB errors propagate to the outer catch (500, no revert).
async function runDobGate(db: Db, bookingId: string): Promise<Response | null> {
  const { assertNoEstimatedDOBs, DOBEstimateUnresolvedError } = await import("@/lib/booking/dob-gate");
  try {
    await assertNoEstimatedDOBs(bookingId);
    return null;
  } catch (err) {
    if (err instanceof DOBEstimateUnresolvedError) {
      await revertSubmitLock(db, bookingId, "bookings.update.revert_lock_on_dob_gate");
      return Response.json(
        { error: "estimated_dob_unresolved", affected_passengers: err.affectedPassengers },
        { status: 409 },
      );
    }
    throw err;
  }
}

// Step 3 — load the tenant (prong, tier, §15.12 sandbox) and resolve
// platform_split_rate from its tier. Fail CLOSED on read error per D-091 — a
// null/errored tenant must not silently default to non-sandbox posture (would
// let a sandboxed tenant's booking reach a real host adapter). Pre-host exit:
// release the lock (#1577); no host call yet.
async function loadTenantAndSplitRate(
  adminDb: AdminDb,
  db: Db,
  bookingId: string,
  tenantId: string,
): Promise<{ response: Response } | { tenant: TenantRow; platform_split_rate: number | null }> {
  const { data: tenantData, error: tenantErr } = await adminDb
    // #1190: the column is tenant_type, not prong (prong was never a column).
    .from("tenants")
    .select("id, tenant_type, tier_id, is_sandbox")
    .eq("id", tenantId)
    .single();

  if (tenantErr || !tenantData) {
    await revertSubmitLock(db, bookingId, "bookings.update.revert_lock_on_tenant_lookup");
    if (tenantErr) return { response: dbErrorResponse(tenantErr) };
    return { response: Response.json({ error: "tenant_lookup_failed" }, { status: 500 }) };
  }

  const tenant = tenantData as TenantRow;
  let platform_split_rate: number | null = null;
  if (tenant.tier_id) {
    const { data: tierData } = await adminDb
      .from("tier_definitions")
      .select("id, platform_split_rate, hold_period_days")
      .eq("id", tenant.tier_id)
      .single();
    if (tierData) platform_split_rate = (tierData as TierRow).platform_split_rate;
  }
  return { tenant, platform_split_rate };
}

// Step 4 — select the adapter (with decrypted per-tenant credentials in ctx;
// Audit pass 2 Finding 8), health-check it, and resolve commission_rate from the
// adapter's stored config. No early exit — the fail-closed decision is Step 5.
async function selectAdapterAndCommissionRate(
  tenantId: string,
  tenant: TenantRow,
  adminDb: AdminDb,
): Promise<{
  adapter: SelectedAdapter["adapter"];
  hostCtx: SelectedAdapter["ctx"];
  health: { ok: boolean };
  commission_rate: number | null;
}> {
  const correlation_id = crypto.randomUUID();
  const { adapter, ctx: hostCtx } = await selectAdapterForCall(
    { id: tenantId, prong: tenant.tenant_type, is_sandbox: tenant.is_sandbox },
    { tenant_id: tenantId, user_id: null, correlation_id },
  );

  const health = await adapter.healthCheck();

  let commission_rate: number | null = null;
  if (health.ok && adapter.capabilities.supports_commission_api) {
    const { data: adapterRow } = await adminDb
      .from("host_adapters")
      .select("config")
      .eq("adapter_id", adapter.adapterId)
      .maybeSingle();
    if (adapterRow) {
      const config = adapterRow.config as Record<string, unknown>;
      const rawRate = config["default_commission_rate"];
      if (typeof rawRate === "number") commission_rate = rawRate;
    }
  }
  return { adapter, hostCtx, health, commission_rate };
}

// Step 5 — §14.4 fail-closed rate gate. If commission_rate or platform_split_rate
// is unresolvable (or the adapter is unhealthy), park the booking in
// pending_host_review with a structured reason, alert platform admin via audit
// log, and return 503. No lock revert — the booking is deliberately parked, not
// re-submittable (the #1764 resolve-review path is the sanctioned exit). On
// success, returns the now-non-null rates for the commission computation.
async function assertRatesResolved(
  db: Db,
  bookingId: string,
  tenantId: string,
  userId: string,
  health: { ok: boolean },
  commission_rate: number | null,
  platform_split_rate: number | null,
): Promise<{ response: Response } | { commission_rate: number; platform_split_rate: number }> {
  if (commission_rate === null || !health.ok) {
    const reason = health.ok ? "commission_rate_unresolvable" : "host_adapter_unhealthy";
    await safeAwait(
      db
        .from("bookings")
        .update({ status: "pending_host_review", review_reason: reason, updated_at: new Date().toISOString() })
        .eq("id", bookingId),
      "bookings.update",
    );
    await writeAuditLog({
      tenant_id: tenantId,
      actor_type: "user",
      actor_user_id: userId,
      action: "booking.commission_rate_resolution",
      resource_type: "booking",
      resource_id: bookingId,
      changes: { outcome: "failed", reason },
    });
    return {
      response: Response.json(
        {
          error:
            "Commission rate could not be resolved for this booking. " +
            "Your booking is pending review. Please contact support if this persists.",
          status: "pending_host_review",
        },
        { status: 503 },
      ),
    };
  }

  if (platform_split_rate === null) {
    await safeAwait(
      db
        .from("bookings")
        .update({
          status: "pending_host_review",
          review_reason: "missing_platform_split",
          updated_at: new Date().toISOString(),
        })
        .eq("id", bookingId),
      "bookings.update",
    );
    await writeAuditLog({
      tenant_id: tenantId,
      actor_type: "user",
      actor_user_id: userId,
      action: "booking.commission_rate_resolution",
      resource_type: "booking",
      resource_id: bookingId,
      changes: { outcome: "failed", reason: "missing_platform_split" },
    });
    return {
      response: Response.json(
        {
          error: "Platform commission split rate is not configured. Your booking is pending review.",
          status: "pending_host_review",
        },
        { status: 503 },
      ),
    };
  }

  return { commission_rate, platform_split_rate };
}

// Step 6 — §14.3 commission computation. Resolves the §12.6 host booking fee
// (tenant override supersedes platform-wide adapter config), computes the money
// bundle, and writes the success audit row. Persists cents + the rule id so the
// math is auditable without re-derivation.
async function computeCommission(
  booking: BookingRow,
  commission_rate: number,
  platform_split_rate: number,
  adapter: SelectedAdapter["adapter"],
  db: Db,
  adminDb: AdminDb,
  tenantId: string,
  userId: string,
): Promise<CommissionComputation> {
  const fare = BigInt(booking.commissionable_fare_cents ?? 0) as Cents;
  const commissionRate = toRate(commission_rate);
  const platformSplitRate = toRate(platform_split_rate);

  const gross_commission_cents = multiplyRate(fare, commissionRate);

  let host_booking_fee_cents = 0n as Cents;
  let host_booking_fee_rule_ref: string | null = null;

  const { data: feeConfig } = await adminDb
    .from("host_booking_fee_configs")
    .select("id, fee_type, flat_fee_amount, percent_of_commission")
    .eq("host_adapter", adapter.adapterId)
    .maybeSingle();
  if (feeConfig) {
    ({ cents: host_booking_fee_cents, ruleRef: host_booking_fee_rule_ref } = resolveHostFeeCents(
      feeConfig as FeeConfigRow,
      gross_commission_cents,
    ));
  }

  const { data: feeOverride } = await db
    .from("tenant_host_fee_overrides")
    .select("id, fee_type, flat_fee_amount, percent_of_commission")
    .eq("host_adapter", adapter.adapterId)
    .maybeSingle();
  if (feeOverride) {
    ({ cents: host_booking_fee_cents, ruleRef: host_booking_fee_rule_ref } = resolveHostFeeCents(
      feeOverride as FeeConfigRow,
      gross_commission_cents,
    ));
  }

  const net_commission_cents = subtractFee(gross_commission_cents, host_booking_fee_cents);
  const platform_retained_cents = multiplyRate(net_commission_cents, platformSplitRate);
  const subhost_payable_cents = subtractFee(net_commission_cents, platform_retained_cents);

  await writeAuditLog({
    tenant_id: tenantId,
    actor_type: "user",
    actor_user_id: userId,
    action: "booking.commission_rate_resolution",
    resource_type: "booking",
    resource_id: booking.id,
    changes: {
      outcome: "success",
      commission_rate,
      platform_split_rate,
      gross_commission_cents: gross_commission_cents.toString(),
      net_commission_cents: net_commission_cents.toString(),
      platform_retained_cents: platform_retained_cents.toString(),
    },
  });

  return {
    fare,
    gross_commission_cents,
    host_booking_fee_cents,
    host_booking_fee_rule_ref,
    net_commission_cents,
    platform_retained_cents,
    subhost_payable_cents,
  };
}

// Step 7 — §21.10.1 quote pricing discipline. For ESTIMATE quotes, re-fetch the
// current host price and compare against the customer-accepted variance: outside
// variance → pending_customer_reconfirmation (no host submission, 409). CONFIRMED
// quotes submit at the locked price. No quote → submit at the booking's own
// amount. Returns the request to dispatch, or a reconfirmation Response.
async function applyQuotePricing(
  db: Db,
  booking: BookingRow,
  adapter: SelectedAdapter["adapter"],
  hostCtx: SelectedAdapter["ctx"],
  tenantId: string,
  userId: string,
): Promise<{ response: Response } | { submitReq: BookingSubmissionRequest }> {
  const { data: quoteData } = await db
    .from("quotes")
    .select(
      "id, price_kind, price_lock_token, price_lock_expires_at, locked_price_cents, estimate_price_cents, customer_accepted_variance_cents, customer_accepted_audit_id",
    )
    .eq("converted_to_booking_id", booking.id)
    .maybeSingle();

  const submitReqBase: BookingSubmissionRequest = {
    contact_id: booking.primary_contact_id ?? "unknown",
    cruise_line: booking.cruise_line ?? "",
    ship_name: booking.ship_name ?? "",
    sailing_date: booking.sailing_date ?? new Date().toISOString().slice(0, 10),
    duration_nights: booking.duration_nights ?? 0,
    cabin_category: booking.cabin_category ?? "",
    passengers: [],
    commissionable_fare_cents: Number(booking.commissionable_fare_cents ?? 0),
    total_amount_cents: Number(booking.total_amount_cents ?? 0),
    currency: booking.currency,
  };
  let submitReq: BookingSubmissionRequest = submitReqBase;

  if (quoteData) {
    const quote = quoteData as {
      id: string;
      price_kind: "estimate" | "confirmed" | null;
      price_lock_token: string | null;
      price_lock_expires_at: string | null;
      locked_price_cents: number | null;
      estimate_price_cents: number | null;
      customer_accepted_variance_cents: number | null;
      customer_accepted_audit_id: string | null;
    };

    if (
      quote.price_kind === "confirmed" &&
      quote.price_lock_expires_at &&
      new Date(quote.price_lock_expires_at) >= new Date() &&
      quote.locked_price_cents != null
    ) {
      submitReq = { ...submitReqBase, total_amount_cents: quote.locked_price_cents };
    } else if (quote.price_kind === "estimate" && adapter.getCurrentPrice) {
      const priceResult = await adapter.getCurrentPrice(submitReqBase, hostCtx);
      if (priceResult.ok) {
        const hostCents = priceResult.value.total_cents;
        const estimateCents = quote.estimate_price_cents ?? submitReqBase.total_amount_cents;
        const allowedVariance = quote.customer_accepted_variance_cents ?? 0;
        const variance = Math.abs(hostCents - estimateCents);
        if (variance > allowedVariance) {
          // Pause for customer reconfirmation; do NOT submit to host.
          await safeAwait(
            db
              .from("bookings")
              .update({ status: "pending_customer_reconfirmation", updated_at: new Date().toISOString() })
              .eq("id", booking.id),
            "bookings.update",
          );
          await writeAuditLog({
            tenant_id: tenantId,
            actor_type: "user",
            actor_user_id: userId,
            action: "quote.reconfirmation_requested",
            resource_type: "quote",
            resource_id: quote.id,
            changes: {
              booking_id: booking.id,
              estimate_cents: estimateCents,
              host_cents: hostCents,
              variance_cents: variance,
              allowed_variance_cents: allowedVariance,
              prior_audit_id: quote.customer_accepted_audit_id,
            },
          });
          return {
            response: Response.json(
              {
                status: "pending_customer_reconfirmation",
                estimate_cents: estimateCents,
                host_cents: hostCents,
                variance_cents: variance,
                allowed_variance_cents: allowedVariance,
              },
              { status: 409 },
            ),
          };
        }
        // Within variance: submit at host price.
        submitReq = { ...submitReqBase, total_amount_cents: hostCents };
      }
      // If adapter.getCurrentPrice failed, fall through with the estimate price
      // as-is. The reconciliation cron catches drift after submit.
    }
  }

  return { submitReq };
}

// Step 8 — dispatch to the host adapter. On host-reported failure the host call
// did NOT create a booking, so revert the CAS lock (#1577) and 502. Previously
// this path left the row in 'submitting' indefinitely.
async function dispatchToHost(
  db: Db,
  adapter: SelectedAdapter["adapter"],
  submitReq: BookingSubmissionRequest,
  hostCtx: SelectedAdapter["ctx"],
  bookingIdStr: string,
): Promise<{ response: Response } | { provider_booking_ref: string }> {
  const submitResult = await adapter.submitBooking(submitReq, hostCtx);
  if (!submitResult.ok) {
    await revertSubmitLock(db, bookingIdStr, "bookings.update.revert_lock_on_host_failure");
    const ref = crypto.randomUUID();
    console.error("[bookings/submit] ref=%s host_adapter_error", ref, submitResult.error);
    return {
      response: Response.json(
        { error: "host_adapter_error", code: submitResult.error.code, ref },
        { status: 502 },
      ),
    };
  }
  return { provider_booking_ref: submitResult.value.provider_booking_ref };
}

// Step 9 — the host booking is now REAL. Persist provider_booking_ref FIRST in
// its own update (#1577) so a crash leaves the ref on the row, then fold the
// commission insert + final status flip into ONE SECURITY DEFINER RPC (#1693).
// The insert is idempotent (commissions_booking_id_uidx, #1575); the status
// flips only if still 'submitting'. commit error → pending_host_review
// (commission_write_failed); 0 rows flipped → a concurrent path (reconcile) owns
// the row → 409. NEITHER reverts to 'draft' (host booking is real → would double-book).
async function persistRefAndCommit(
  db: Db,
  adminDb: AdminDb,
  booking: BookingRow,
  adapter: SelectedAdapter["adapter"],
  tenant: TenantRow,
  provider_booking_ref: string,
  commission_rate: number,
  platform_split_rate: number,
  comp: CommissionComputation,
): Promise<{ response: Response } | { ok: true }> {
  await safeAwait(
    db
      // d091-allow:service-role-tenant — db is tenantClient(ctx), RLS-scoped to ctx.tenant_id; not a service-role write.
      .from("bookings")
      .update({ provider_booking_ref, host_adapter: adapter.adapterId, updated_at: new Date().toISOString() })
      .eq("id", booking.id),
    "bookings.update.persist_host_ref",
  );

  const { data: committedCount, error: commitError } = await adminDb.rpc("submit_commit_booking", {
    p_booking_id: booking.id,
    p_tenant_id: tenant.id,
    p_provider_booking_ref: provider_booking_ref,
    p_host_adapter: adapter.adapterId,
    p_is_sandbox: tenant.is_sandbox,
    p_commissionable_fare_cents: comp.fare.toString(),
    p_commission_rate: commission_rate,
    p_platform_split_rate: platform_split_rate,
    p_gross_commission_cents: comp.gross_commission_cents.toString(),
    p_host_booking_fee_cents: comp.host_booking_fee_cents.toString(),
    p_host_booking_fee_rule_ref: comp.host_booking_fee_rule_ref,
    p_net_commission_cents: comp.net_commission_cents.toString(),
    p_platform_retained_cents: comp.platform_retained_cents.toString(),
    p_subhost_payable_cents: comp.subhost_payable_cents.toString(),
    p_currency: booking.currency,
  });

  if (commitError) {
    await safeAwait(
      db
        // d091-allow:service-role-tenant — db is tenantClient(ctx), RLS-scoped to ctx.tenant_id; not a service-role write.
        .from("bookings")
        .update({
          status: "pending_host_review",
          review_reason: "commission_write_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", booking.id),
      "bookings.update.commission_write_failed",
    );
    return { response: dbErrorResponse(commitError) };
  }

  if (!committedCount) {
    const ref = crypto.randomUUID();
    console.error("[bookings/submit] ref=%s commit_lost_race booking=%s", ref, booking.id);
    return { response: Response.json({ error: "booking_state_changed", ref }, { status: 409 }) };
  }

  return { ok: true };
}

// Step 10 — post-commit side effects. Both are NON-FATAL: a failure here must not
// unwind the host-system commit. §35.6 conversion-touch attribution (read fresh,
// §35.6.2) + §37.4.2 booking_confirmed task-sequence fan-out.
async function runPostCommitSideEffects(
  db: Db,
  adminDb: AdminDb,
  booking: BookingRow,
  tenantId: string,
  userId: string,
): Promise<void> {
  if (booking.primary_contact_id) {
    const { populateConversionTouch } = await import("@/lib/attribution/populate-conversion-touch");
    await populateConversionTouch({
      tenant_id: tenantId,
      contact_id: booking.primary_contact_id,
      target_table: "bookings",
      target_id: booking.id,
      svc: adminDb,
    });
  }

  try {
    const { triggerMatchingSequences } = await import("@/lib/tasks/sequence-engine");
    await triggerMatchingSequences({
      tenant_id: tenantId,
      trigger: "booking_confirmed",
      record: { booking_id: booking.id },
      triggered_by_user_id: userId,
      svc: db,
    });
  } catch (seqErr) {
    console.warn("[bookings/submit] sequence fan-out failed:", seqErr);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bookings", action: "submit" });
    const { id: bookingId } = await params;

    // §7.9 — Idempotency-Key support. Wraps the rest of the handler. If the
    // client sends the same key for the same (route, user) within 24h, the
    // cached response is replayed and the handler does NOT re-run. Bookings/submit
    // is the highest-impact mutation (real money + host adapter call).
    return await withIdempotencyKey(
      req,
      { route: "bookings.submit", auth_user_id: user.id, tenant_id: ctx.tenant_id },
      () => submitBooking(req, bookingId, ctx, user),
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}

async function submitBooking(
  _req: Request,
  bookingIdStr: string,
  ctx: Awaited<ReturnType<typeof assertPermission>>["ctx"],
  user: Awaited<ReturnType<typeof assertPermission>>["user"],
): Promise<Response> {
  try {
    const db = tenantClient(ctx);
    const adminDb = createServiceRoleClient();

    const loaded = await loadAndLockBooking(db, bookingIdStr);
    if ("response" in loaded) return loaded.response;
    const { booking } = loaded;

    const dobResponse = await runDobGate(db, bookingIdStr);
    if (dobResponse) return dobResponse;

    const tenantResult = await loadTenantAndSplitRate(adminDb, db, bookingIdStr, ctx.tenant_id);
    if ("response" in tenantResult) return tenantResult.response;
    const { tenant, platform_split_rate } = tenantResult;

    const { adapter, hostCtx, health, commission_rate } = await selectAdapterAndCommissionRate(
      ctx.tenant_id,
      tenant,
      adminDb,
    );

    const rates = await assertRatesResolved(
      db,
      bookingIdStr,
      ctx.tenant_id,
      user.id,
      health,
      commission_rate,
      platform_split_rate,
    );
    if ("response" in rates) return rates.response;

    const comp = await computeCommission(
      booking,
      rates.commission_rate,
      rates.platform_split_rate,
      adapter,
      db,
      adminDb,
      ctx.tenant_id,
      user.id,
    );

    const priced = await applyQuotePricing(db, booking, adapter, hostCtx, ctx.tenant_id, user.id);
    if ("response" in priced) return priced.response;

    const dispatched = await dispatchToHost(db, adapter, priced.submitReq, hostCtx, bookingIdStr);
    if ("response" in dispatched) return dispatched.response;
    const { provider_booking_ref } = dispatched;

    const committed = await persistRefAndCommit(
      db,
      adminDb,
      booking,
      adapter,
      tenant,
      provider_booking_ref,
      rates.commission_rate,
      rates.platform_split_rate,
      comp,
    );
    if ("response" in committed) return committed.response;

    await runPostCommitSideEffects(db, adminDb, booking, ctx.tenant_id, user.id);

    return Response.json({ ok: true, provider_booking_ref, status: "submitted" });
  } catch (err) {
    // #1577 — an unexpected throw here is a server fault, not an auth failure:
    // return 500 (was a misleading 401) and do NOT echo the raw error message.
    // We deliberately do NOT revert the lock: the throw may have landed after
    // the host adapter call, so the row could carry a real host booking. The
    // reconcile cron routes any stuck 'submitting' row to pending_host_review.
    const ref = crypto.randomUUID();
    console.error("[bookings/submit] ref=%s unhandled_error", ref, err);
    return Response.json({ error: "booking_submit_failed", ref }, { status: 500 });
  }
}
