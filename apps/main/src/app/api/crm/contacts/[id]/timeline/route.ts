// §12 — Contact timeline: merged chronological view of conversations, quotes,
// bookings, and audit-log events linked to a contact.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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

    if (contactErr) return dbErrorResponse(contactErr);
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
        .select("id, created_at, status, cruise_line, ship_name, sailing_date, total_amount_cents, cruise_line_id, cruise_lines(display_name)")
        .eq("primary_contact_id", id)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

    if (convResult.error) return dbErrorResponse(convResult.error);
    if (quotesResult.error) return dbErrorResponse(quotesResult.error);
    if (bookingsResult.error) return dbErrorResponse(bookingsResult.error);

    // #1728 — inbound persona-email replies attached to this contact's
    // conversations (source='email', role='user'). Bounded (D-091 #25). Scoped
    // to the contact's own conversation ids; RLS is the second isolation layer.
    const convIds = (convResult.data ?? []).map((c) => c.id);
    let emailRows: { id: string; created_at: string; content: string }[] = [];
    if (convIds.length > 0) {
      const emailResult = await db
        .from("messages")
        .select("id, created_at, content")
        .in("conversation_id", convIds)
        .eq("source", "email")
        .order("created_at", { ascending: false })
        .limit(50);
      if (emailResult.error) return dbErrorResponse(emailResult.error);
      emailRows = (emailResult.data ?? []) as typeof emailRows;
    }

    const timeline = [
      ...(convResult.data ?? []).map((c) => ({ type: "conversation", ...c })),
      ...(quotesResult.data ?? []).map((q) => ({ type: "quote", ...q })),
      ...(bookingsResult.data ?? []).map((b) => ({ type: "booking", ...b })),
      ...emailRows.map((e) => ({ type: "email", ...e })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return Response.json({ timeline });
  } catch (err) {
    return respondToAuthError(err);
  }
}
