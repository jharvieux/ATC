// §18.7 — RSVP state update (form-submit and JSON handler from the invitee page).

import { parseAndVerifyHmac } from "@/lib/groups/invitation-token";
import { createClient } from "@supabase/supabase-js";

const VALID_RSVP = new Set(["pending", "interested", "not_going", "booked"]);

export async function POST(req: Request, { params }: { params: { token: string } }): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  let rsvp_state: string | null = null;

  if (contentType.includes("application/json")) {
    const body = await req.json() as { rsvp_state?: string };
    rsvp_state = body.rsvp_state ?? null;
  } else {
    const form = await req.formData();
    rsvp_state = form.get("rsvp_state") as string | null;
  }

  if (!rsvp_state || !VALID_RSVP.has(rsvp_state)) {
    return Response.json({ error: "Invalid rsvp_state" }, { status: 400 });
  }

  const { invitation_id, ok } = parseAndVerifyHmac(params.token);
  if (!ok) return Response.json({ error: "invalid_token" }, { status: 400 });

  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const { error } = await svc
    .from("invitations")
    .update({ rsvp_state })
    .eq("id", invitation_id)
    .is("token_revoked_at", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  // If form submission, redirect back to the invitee page.
  if (!contentType.includes("application/json")) {
    const origin = new URL(req.url).origin;
    return Response.redirect(`${origin}/group/invite/${params.token}?rsvp=updated`, 302);
  }

  return Response.json({ ok: true, rsvp_state });
}
