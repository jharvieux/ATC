// BP38 §38.4.3 — Customer-side option selection via tokenized URL.
//
// Public endpoint (no auth). Body: { option_id }. Validates that the
// option belongs to the token's quote, unselects any prior selection,
// marks this one selected, transitions the quote container to
// 'accepted'. Returns the booking-flow URL the customer should be
// redirected to per §38.4.3 step 3.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const svc = createServiceRoleClient();

  const body = (await req.json().catch(() => null)) as { option_id?: unknown } | null;
  const optionId = typeof body?.option_id === "string" ? body.option_id : null;
  if (!optionId) return Response.json({ error: "option_id required" }, { status: 400 });

  // Resolve quote via token; must be in 'sent' or 'viewed' status (not
  // draft, not accepted, not declined, not expired).
  const { data: quoteData } = await svc
    .from("quotes")
    .select("id, tenant_id, status")
    .eq("customer_access_token", token)
    .maybeSingle();
  if (!quoteData) return Response.json({ error: "not_found" }, { status: 404 });
  const quote = quoteData as { id: string; tenant_id: string; status: string };
  if (quote.status !== "sent" && quote.status !== "viewed") {
    return Response.json(
      { error: "quote_not_selectable", current_status: quote.status },
      { status: 409 },
    );
  }

  // Verify option belongs to this quote.
  const { data: optData } = await svc
    .from("quote_options")
    .select("id, quote_id")
    .eq("id", optionId)
    .maybeSingle();
  if (!optData || (optData as { quote_id: string }).quote_id !== quote.id) {
    return Response.json({ error: "option_not_on_quote" }, { status: 404 });
  }

  const now = new Date().toISOString();
  // Unselect any prior selection on this quote.
  await svc
    .from("quote_options")
    .update({ customer_selected: false, customer_selected_at: null })
    .eq("quote_id", quote.id);
  // Select this option.
  await svc
    .from("quote_options")
    .update({ customer_selected: true, customer_selected_at: now })
    .eq("id", optionId);
  // Transition the quote container.
  await svc
    .from("quotes")
    .update({ status: "accepted", accepted_at: now, updated_at: now })
    .eq("id", quote.id);

  return Response.json({
    ok: true,
    quote_id: quote.id,
    option_id: optionId,
    next_url: `/booking/start?from_quote=${quote.id}&option=${optionId}`,
  });
}
