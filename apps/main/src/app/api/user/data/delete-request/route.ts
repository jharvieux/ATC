// §17.10 — CCPA data deletion request.
// POST: user must confirm by typing their own email address.
// Sets users.deleted_at and schedules a purge Inngest job at +30 days.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";

interface DeleteBody {
  email_confirmation: string;
}

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const accessToken = authHeader.slice("Bearer ".length);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabase = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const authUser = authData.user;
  const authUserId = authUser.id;

  let body: DeleteBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // Confirm email matches.
  const userEmail = authUser.email ?? "";
  if (!body.email_confirmation || body.email_confirmation.trim().toLowerCase() !== userEmail.toLowerCase()) {
    return Response.json({ error: "email_confirmation_mismatch" }, { status: 422 });
  }

  const db = createServiceRoleClient();

  // Check not already deleted.
  const { data: userRow } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (!userRow) return Response.json({ error: "user_not_found" }, { status: 404 });

  const typedUser = userRow as { id: string; deleted_at: string | null };
  if (typedUser.deleted_at) {
    return Response.json({ error: "already_deleted" }, { status: 409 });
  }

  const deletedAt = new Date().toISOString();
  const purgeAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Set deleted_at — starts the 30-day grace period.
  const { error: updateErr } = await db
    .from("users")
    .update({ deleted_at: deletedAt })
    .eq("auth_user_id", authUserId);

  if (updateErr) return Response.json({ error: updateErr.message }, { status: 500 });

  // Schedule purge job after 30 days.
  await inngest.send({
    name: "user.data_purge_scheduled",
    data: {
      auth_user_id: authUserId,
      user_id: typedUser.id,
      deleted_at: deletedAt,
      purge_at: purgeAt,
    },
  });

  return Response.json({ ok: true, deleted_at: deletedAt, purge_at: purgeAt });
}
