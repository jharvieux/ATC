// §14.4 / #1764 — POST /api/bookings/[id]/resolve-review.
//
// Operator action that returns a booking parked in `pending_host_review` to
// `draft` so the agent can correct trip details and re-run the normal submit
// flow. Only bookings whose review reason predates the host adapter call are
// eligible; see lib/bookings/state-machine.ts for the boundary-safety rationale
// (reverting a post-host booking would double-book — #1577).

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { resolvePendingHostReview } from "@/lib/bookings/state-machine";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "bookings",
      action: "resolve_review",
    });
    const { id: bookingId } = await params;

    const result = await resolvePendingHostReview({
      db: tenantClient(ctx),
      bookingId,
      actorUserId: user.id,
      tenantId: ctx.tenant_id,
    });

    if (result.ok) {
      return Response.json({ ok: true, status: "draft" });
    }
    if (result.code === "not_found") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (result.code === "not_in_review") {
      return Response.json(
        { error: "not_in_pending_host_review", current_status: result.status },
        { status: 409 },
      );
    }
    // host_booking_may_exist — a live host reservation may exist; refuse.
    return Response.json(
      {
        error: "host_booking_may_exist",
        review_reason: result.review_reason,
        message:
          "This booking may have a live host reservation and cannot be returned to draft. " +
          "Manual reconciliation is required.",
      },
      { status: 409 },
    );
  } catch (err) {
    return respondToAuthError(err);
  }
}
