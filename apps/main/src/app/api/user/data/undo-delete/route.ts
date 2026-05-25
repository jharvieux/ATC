// §17.10 — CCPA deletion undo.
// POST: clear users.deleted_at if within the 30-day grace period.
//
// 2026-05-25 — tenant-scoped per audit finding Auth #4. Restore matches
// the per-tenant delete shape: undoing on tenant A only clears tenant A.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

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
  const authUserId = authData.user.id;

  const tenantId = req.headers.get("x-resolved-tenant-id");
  if (!tenantId || tenantId === "platform") {
    return Response.json({ error: "tenant_unresolved" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  const { data: userRow } = await db
    .from("users")
    .select("id, deleted_at")
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!userRow) return Response.json({ error: "user_not_found" }, { status: 404 });

  const typedUser = userRow as { id: string; deleted_at: string | null };

  if (!typedUser.deleted_at) {
    return Response.json({ error: "not_deleted" }, { status: 409 });
  }

  const deletedAt = new Date(typedUser.deleted_at).getTime();
  const gracePeriodEnd = deletedAt + 30 * 24 * 60 * 60 * 1000;
  if (Date.now() >= gracePeriodEnd) {
    return Response.json({ error: "grace_period_expired" }, { status: 410 });
  }

  const { error: updateErr } = await db
    .from("users")
    .update({ deleted_at: null })
    .eq("auth_user_id", authUserId)
    .eq("tenant_id", tenantId);

  if (updateErr) return Response.json({ error: updateErr.message }, { status: 500 });

  return Response.json({ ok: true });
}
