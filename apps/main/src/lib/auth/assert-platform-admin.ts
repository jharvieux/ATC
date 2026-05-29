// §26 — Platform-admin authorization gate.
//
// Replaces the prior pattern of reading `req.headers.get("x-admin-user-id")`
// (which was unauthenticated and the audit's HIGH-confidence Finding 1).
//
// Two paths are accepted:
//
//   1) Service-to-service Bearer
//      Authorization: Bearer ${MAIN_APP_ADMIN_API_KEY}
//      Used by the RAG cron reconcilers and other server-to-server callers
//      that don't have a Supabase session. Returns admin_user_id = the
//      special sentinel "service:bearer" so audit rows can distinguish
//      service callers from human admins.
//
//   2) Supabase user session
//      Authorization: Bearer <supabase-session-jwt>
//      The handler verifies the JWT via supabase.auth.getUser() and looks
//      up the resulting auth_user_id in `platform_admins`. Membership in
//      that table is the authoritative platform-admin signal.
//
// Throws an instance of PlatformAdminError on any failure, so callers can
// `try { ... } catch (e) { return e.toResponse(); }`. The error carries the
// right HTTP status (401 for missing/invalid token, 403 for token-valid-but-
// not-an-admin, 500 for misconfiguration).

import { createClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { constantTimeEqual } from "@/lib/auth/constant-time-equal";

export interface PlatformAdminContext {
  /** auth_user_id from Supabase (human admin), or "service:bearer" for the service-to-service bearer path. */
  admin_user_id: string;
  /** Role string from platform_admins, or "service" for the bearer path. */
  role: string;
  /** Discriminator so callers can branch on how authorization happened. */
  via: "session" | "bearer";
}

export class PlatformAdminError extends Error {
  constructor(
    public readonly status: 401 | 403 | 500,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlatformAdminError";
  }
  toResponse(): Response {
    return Response.json({ error: this.code, detail: this.message }, { status: this.status });
  }
}

/**
 * Asserts the request bears a valid platform-admin credential. Returns the
 * resolved admin context, or throws PlatformAdminError.
 *
 * Call at the top of every /api/admin/* route handler.
 */
export async function assertPlatformAdmin(req: Request): Promise<PlatformAdminContext> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new PlatformAdminError(401, "missing_bearer", "Missing Authorization: Bearer header.");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new PlatformAdminError(401, "empty_bearer", "Bearer token is empty.");
  }

  // Path 1 — service-to-service Bearer (RAG cron, etc.). Constant-time
  // compare prevents the recovery-via-timing primitive flagged in audit
  // pass 2, Finding 2.
  const serviceKey = process.env.MAIN_APP_ADMIN_API_KEY;
  if (serviceKey && constantTimeEqual(token, serviceKey)) {
    return { admin_user_id: "service:bearer", role: "service", via: "bearer" };
  }

  // Path 2 — Supabase user session.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new PlatformAdminError(500, "server_misconfigured", "Supabase env vars missing.");
  }

  const supabase = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    throw new PlatformAdminError(401, "invalid_session", "Session JWT failed verification.");
  }

  const db = createServiceRoleClient();
  const { data: adminRow, error: lookupErr } = await db
    .from("platform_admins")
    .select("auth_user_id, role")
    .eq("auth_user_id", authData.user.id)
    .maybeSingle();

  if (lookupErr) {
    // Log full error server-side; surface a static message to the client.
    // Audit pass 2, Finding 3: PostgREST errors can contain schema hints
    // (column names, RLS predicate names). Don't reveal them on 500.
    console.error("[assertPlatformAdmin] platform_admins lookup failed:", lookupErr);
    throw new PlatformAdminError(500, "platform_admins_lookup_failed", "Lookup failed.");
  }
  if (!adminRow) {
    throw new PlatformAdminError(
      403,
      "not_a_platform_admin",
      "Authenticated user is not in platform_admins.",
    );
  }

  const typed = adminRow as { auth_user_id: string; role: string };
  return { admin_user_id: typed.auth_user_id, role: typed.role, via: "session" };
}
