// BP38 §38.4.3 — Customer-side option selection.
//
// Tokenized customer endpoint: sets the option as customer_selected,
// unselects any prior choice (UNIQUE partial index makes us serialize),
// transitions the quote container to status='accepted' + accepted_at=NOW.
//
// Auth model: a tokenized URL grants the customer access; for now we
// require service-role validation via a header — full token verification
// is a follow-up that integrates with the existing tokenized quote-view
// auth path.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // Until the tokenized customer-view flow is wired (follow-up), require
    // agent-level permission. The agent's "select on behalf of customer"
    // flow uses this endpoint; customer-side selection will be added when
    // the token endpoint lands.
    const { ctx } = await assertPermission(req, { resource: "quotes.options", action: "select" });
    const { id: optionId } = await params;
    const svc = createServiceRoleClient();

    // Load + tenant scope.
    const { data: row, error: loadErr } = await svc
      .from("quote_options")
      .select("id, tenant_id, quote_id")
      .eq("id", optionId)
      .maybeSingle();
    if (loadErr) return Response.json({ error: loadErr.message }, { status: 500 });
    if (!row || (row as { tenant_id: string }).tenant_id !== ctx.tenant_id) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const { quote_id } = row as { quote_id: string };

    // Unselect any prior option on this quote.
    await safeAwait(svc
      .from("quote_options")
      .update({ customer_selected: false, customer_selected_at: null })
      .eq("quote_id", quote_id)
      .eq("tenant_id", ctx.tenant_id), "quote_options.update");

    // Select this one.
    const now = new Date().toISOString();
    const { error: updErr } = await svc
      .from("quote_options")
      .update({ customer_selected: true, customer_selected_at: now })
      .eq("id", optionId)
      .eq("tenant_id", ctx.tenant_id);
    if (updErr) return Response.json({ error: updErr.message }, { status: 500 });

    // Transition the quote container.
    await safeAwait(svc
      .from("quotes")
      .update({ status: "accepted", accepted_at: now })
      .eq("id", quote_id)
      .eq("tenant_id", ctx.tenant_id), "quotes.update");

    return Response.json({ ok: true, quote_id, option_id: optionId });
  } catch (err) {
    return respondToAuthError(err);
  }
}
