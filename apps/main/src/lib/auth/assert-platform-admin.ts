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
//   2) Supabase user session via HttpOnly cookies (§17.x)
//      createRequestScopedClient reads the session cookies set by
//      /api/auth/callback; supabase.auth.getUser() verifies the JWT. We
//      then look the resulting auth_user_id up in `platform_admins` —
//      membership there is the authoritative platform-admin signal.
//
// Throws an instance of PlatformAdminError on any failure, so callers can
// `try { ... } catch (e) { return e.toResponse(); }`. The error carries the
// right HTTP status (401 for missing/invalid token, 403 for token-valid-but-
// not-an-admin, 500 for misconfiguration).

import { cache as reactCache } from "react";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { constantTimeEqual } from "@/lib/auth/constant-time-equal";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { type PlatformAdminRole, type AdminArea, ADMIN_AREA_GRANTS } from "@/lib/auth/platform-admin-roles";

export type { PlatformAdminRole, AdminArea };

export interface PlatformAdminContext {
  /** auth_user_id from Supabase (human admin), or "service:bearer" for the service-to-service bearer path. */
  admin_user_id: string;
  /** Role from platform_admins, or "service" for the bearer path. */
  role: PlatformAdminRole | "service";
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
  // Path 1 — service-to-service Bearer (RAG cron, etc.). Constant-time
  // compare prevents the recovery-via-timing primitive flagged in audit
  // pass 2, Finding 2.
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const serviceKey = process.env.MAIN_APP_ADMIN_API_KEY;
    if (token && serviceKey && constantTimeEqual(token, serviceKey)) {
      return { admin_user_id: "service:bearer", role: "service", via: "bearer" };
    }
    // Bearer present but not the service key — fall through to the cookie
    // session path (the human-admin Bearer-JWT path is gone; cookies are
    // the authoritative session source).
  }

  // Path 2 — Supabase user session via cookies. Translate the helper's env
  // error into PlatformAdminError(500) so callers keep the structured shape.
  let supabase;
  try {
    supabase = createRequestScopedClient(req);
  } catch (e) {
    throw new PlatformAdminError(
      500,
      "server_misconfigured",
      e instanceof Error ? e.message : "Supabase env vars missing.",
    );
  }

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

  const typed = adminRow as { auth_user_id: string; role: PlatformAdminRole };
  return { admin_user_id: typed.auth_user_id, role: typed.role, via: "session" };
}

/**
 * Asserts the caller is a platform admin AND has the `superadmin` role. Gates
 * platform-admin MANAGEMENT (add / change role / remove other admins) — the
 * first per-role check on the platform side. The service-to-service bearer
 * (role "service") is not a superadmin, so it is rejected here by design.
 */
export async function assertSuperadmin(req: Request): Promise<PlatformAdminContext> {
  const ctx = await assertPlatformAdmin(req);
  if (ctx.role !== "superadmin") {
    throw new PlatformAdminError(
      403,
      "not_a_superadmin",
      "Only superadmins can manage platform admins.",
    );
  }
  return ctx;
}

/**
 * Asserts the caller has a platform-admin credential AND one of the specified
 * allowed roles. Use in API route handlers where role-scoped access is needed.
 *
 * @param allowedRoles - Roles that may access this resource. Include "service"
 *   to permit the service-to-service bearer path (RAG cron, etc.).
 */
export async function assertPlatformRole(
  req: Request,
  allowedRoles: (PlatformAdminRole | "service")[],
): Promise<PlatformAdminContext> {
  const ctx = await assertPlatformAdmin(req);
  if (!allowedRoles.includes(ctx.role)) {
    throw new PlatformAdminError(
      403,
      "insufficient_role",
      `This action requires one of: ${allowedRoles.join(", ")}.`,
    );
  }
  return ctx;
}

// ─── Resource-centric area gates ─────────────────────────────────────────────

/** Route-level area gate. Checks ADMIN_AREA_GRANTS[area] from the matrix. */
export async function assertPlatformAdminArea(
  req: Request,
  area: AdminArea,
): Promise<PlatformAdminContext> {
  const ctx = await assertPlatformAdmin(req);
  const allowed = ADMIN_AREA_GRANTS[area] as readonly string[];
  if (!allowed.includes(ctx.role)) {
    throw new PlatformAdminError(
      403,
      "insufficient_role",
      `Area "${area}" requires one of: ${allowed.join(", ")}.`,
    );
  }
  return ctx;
}

// ─── React.cache helpers for server-component pages ───────────────────────────
// Follows the same pattern as get-cached-user.ts: one DB lookup per request
// shared between (admin)/layout.tsx and any page that calls getCachedAdminContext().
//
// React.cache is server-only; guard for vitest the same way get-cached-user does.
type CacheFn = <T extends (...a: never[]) => unknown>(fn: T) => T;
const _cache: CacheFn = (() => {
  if (typeof reactCache === "function") return reactCache as CacheFn;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "assert-platform-admin: react.cache missing in production — admin DB lookup would double.",
    );
  }
  return (fn) => fn;
})();

/**
 * Request-scoped memoised admin-context lookup for server components.
 * Call from pages inside (admin)/ that need to check the caller's role.
 * The layout also calls this; React.cache ensures a single DB round-trip.
 *
 * Returns null when the caller is not a valid platform admin (missing
 * session, not in platform_admins, etc.). The layout already blocks
 * unauthenticated callers via notFound(), so null here is a belt-and-
 * suspenders signal that shouldn't normally surface in production.
 */
export const getCachedAdminContext = _cache(async (): Promise<PlatformAdminContext | null> => {
  const incoming = await headers();
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const authorization = incoming.get("authorization");
  if (authorization) forwarded.set("authorization", authorization);
  try {
    return await assertPlatformAdmin(
      new Request("https://admin.internal/", { headers: forwarded }),
    );
  } catch {
    return null;
  }
});

/**
 * Convenience for pages: gets the admin context and throws notFound() if the
 * caller's role is not in allowedRoles. Returns the full context so the page
 * can use admin_user_id / role without a second call.
 */
export async function assertPlatformRolePage(
  allowedRoles: (PlatformAdminRole | "service")[],
): Promise<PlatformAdminContext> {
  // next/navigation is a server-only import; import inline to avoid
  // pulling it into edge/test environments where it doesn't exist.
  const { notFound } = await import("next/navigation");
  const ctx = await getCachedAdminContext();
  if (!ctx || !allowedRoles.includes(ctx.role)) {
    notFound();
    // notFound() throws internally in Next.js (NEXT_NOT_FOUND) — this
    // line is unreachable but satisfies TypeScript's control-flow analysis.
    throw new Error("unreachable");
  }
  return ctx;
}

/** Page-level area gate using the ADMIN_AREA_GRANTS matrix. */
export async function assertPlatformAdminAreaPage(area: AdminArea): Promise<PlatformAdminContext> {
  const { notFound } = await import("next/navigation");
  const ctx = await getCachedAdminContext();
  const allowed = ADMIN_AREA_GRANTS[area] as readonly string[];
  if (!ctx || !allowed.includes(ctx.role)) {
    notFound();
    throw new Error("unreachable");
  }
  return ctx;
}

