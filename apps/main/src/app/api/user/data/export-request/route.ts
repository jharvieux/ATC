// §17.9 — CCPA data export request.
// POST: creates an export job for the authenticated user.
// Rate-limited: 1 request per 30 days.

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { inngest } from "@/inngest/client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

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

  const db = createServiceRoleClient();

  // Rate limit: 1 export per 30 days.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await db
    .from("user_data_export_requests")
    .select("id, requested_at")
    .eq("auth_user_id", authUserId)
    .gte("requested_at", thirtyDaysAgo)
    .limit(1);

  if (existing && existing.length > 0) {
    return Response.json(
      { error: "rate_limited", message: "Only 1 export request per 30 days." },
      { status: 429 },
    );
  }

  // Insert the export request row.
  const { data: row, error: insertErr } = await db
    .from("user_data_export_requests")
    .insert({ auth_user_id: authUserId })
    .select("id")
    .single();

  if (insertErr || !row) {
    return dbErrorResponse(insertErr);
  }

  const exportRequestId = (row as { id: string }).id;

  // Queue the build job.
  await inngest.send({
    name: "user.data_export_requested",
    data: { auth_user_id: authUserId, export_request_id: exportRequestId },
  });

  return Response.json({ ok: true, export_request_id: exportRequestId });
}
