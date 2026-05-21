// Spec ref: §7.9 (API calling conventions)
//
// assertPermission verifies that the caller is an authenticated, active member
// of the resolved tenant, then returns the TenantContext and the raw Supabase
// auth user. Route handlers call this at the top of every handler body.
//
// Full RBAC/permission matrix is in a later spec section.
// TODO(rbac): evaluate `opts.resource` + `opts.action` against the permission
// matrix when that section lands. For now the params are logged and we proceed.

import { createClient } from "@supabase/supabase-js";
import { tenantContextFromRequest } from "@/lib/db/factories";
import type { TenantContext } from "@/lib/db/tenant-context";

export type User = {
  id: string;
  auth_user_id: string;
  tenant_id: string;
  status: string;
};

export async function assertPermission(
  req: Request,
  opts: { resource: string; action: string },
): Promise<{ ctx: TenantContext; user: User }> {
  // TODO(rbac): log resource + action for future matrix evaluation
  console.log("[assertPermission] resource=%s action=%s", opts.resource, opts.action);

  const ctx = await tenantContextFromRequest(req);

  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("assertPermission: missing Authorization Bearer token.");
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
    throw new Error("assertPermission: invalid or expired access token.");
  }

  const { data: row, error } = await supabase
    .from("users")
    .select("id, auth_user_id, tenant_id, status")
    .eq("auth_user_id", authData.user.id)
    .eq("tenant_id", ctx.tenant_id)
    .maybeSingle();

  if (error) {
    throw new Error(`assertPermission: DB error: ${error.message}`);
  }
  if (!row || row.status !== "active") {
    throw new Error(
      "assertPermission: user is not an active member of the resolved tenant.",
    );
  }

  return { ctx, user: row as User };
}
