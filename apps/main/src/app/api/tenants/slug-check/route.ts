// §15.3 — Slug uniqueness check for onboarding profile stage.
// Used client-side before form submit; DB constraint enforces final uniqueness.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const candidate = url.searchParams.get("candidate")?.trim().toLowerCase();

  if (!candidate) {
    return Response.json({ error: "candidate is required" }, { status: 400 });
  }

  if (!/^[a-z0-9-]{3,63}$/.test(candidate)) {
    return Response.json({ available: false, reason: "invalid_format" });
  }

  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("tenants")
    .select("id")
    .eq("slug", candidate)
    .maybeSingle();

  if (error) {
    return dbErrorResponse();
  }

  return Response.json({ available: data === null });
}
