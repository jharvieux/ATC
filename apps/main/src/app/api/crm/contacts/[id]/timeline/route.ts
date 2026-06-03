// §12 — Contact timeline: merged chronological view of conversations, quotes,
// bookings, and audit-log events linked to a contact.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "contacts", action: "read" });
    const db = tenantClient(ctx);
    const { id } = await params;

    // Verify contact exists and belongs to this tenant
    const { data: contact, error: contactErr } = await db
      .from("contacts")
      .select("id")
      .eq("id", id)
      .maybeSingle();

    if (contactErr) return Response.json({ error: contactErr.message }, { status: 500 });
    if (!contact) return Response.json({ error: "not_found" }, { status: 404 });

    // Fetch related conversations, quotes, bookings in parallel
    const [convResult, quotesResult, bookingsResult] = await Promise.all([
      db
        .from("conversations")
        .select("id, created_at, status, summary")
        .eq("contact_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        // §38 — trip detail moved to quote_options; the timeline only renders
        // type/created_at/status, so the container row is all we need.
        .from("quotes")
        .select("id, created_at, status")
        .eq("contact_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("bookings")
        .select("id, created_at, status, cruise_line, ship_name, sailing_date, total_amount_cents")
        .eq("primary_contact_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    if (convResult.error) return Response.json({ error: convResult.error.message }, { status: 500 });
    if (quotesResult.error) return Response.json({ error: quotesResult.error.message }, { status: 500 });
    if (bookingsResult.error) return Response.json({ error: bookingsResult.error.message }, { status: 500 });

    const timeline = [
      ...(convResult.data ?? []).map((c) => ({ type: "conversation", ...c })),
      ...(quotesResult.data ?? []).map((q) => ({ type: "quote", ...q })),
      ...(bookingsResult.data ?? []).map((b) => ({ type: "booking", ...b })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return Response.json({ timeline });
  } catch (err) {
    return respondToAuthError(err);
  }
}
