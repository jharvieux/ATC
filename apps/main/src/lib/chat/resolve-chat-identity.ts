// §24 / #860 / #902 — caller identity resolution for the chat route.
//
// The chat turn distinguishes exactly two identity kinds, and prod bug #850
// came from conflating the ids inside them:
//   • member — a resolved tenant member (customer OR verified TA). Carries the
//     AUTH id (auth.users.id, platform_admins key) AND the public.users.id (FK
//     target for conversations / ai_call_log / customer_*). Writing the auth id
//     into a users(id) FK column 500s — they must never be conflated.
//   • anon   — no credential, invalid/expired session, or a non-member. Anon
//     attribution rides conversation_id, never user_id; a minimal ctx is forged
//     so downstream helpers that only need tenant_id still work.
//
// Returning a discriminated union (instead of a nullable trio + a comment-only
// "step 1 forged a ctx" invariant) is what lets handleChat drop the `ctx!`
// non-null assertion at the generation-loop call.

import { tenantContextFromRequest } from "@/lib/db/factories";
import type { TenantContext } from "@/lib/db/tenant-context";
import type { SupabaseClient } from "@supabase/supabase-js";

export type MemberIdentity = {
  ctx: TenantContext;
  userId: string;       // public.users.id (FK target)
  authUserId: string;   // auth.users.id (platform_admins key)
  customerEmail: string | null;
  role: string | null;  // public.users.role — the TA-mode boundary (#902)
};

export type ChatIdentity =
  | ({ kind: "member" } & MemberIdentity)
  | { kind: "anon"; ctx: TenantContext; anonSessionId: string | null };

// #860/#902 — resolve a credentialed request to a member of the resolved
// tenant. Returns null for invalid/expired sessions, non-members, and missing
// users rows. The customer path degrades null to anonymous (#860 — never
// hard-error a customer turn); the TA path hard-fails null with a 403 (#902 —
// never silently downgrade a staff request).
export async function resolveMemberIdentity(
  req: Request,
  tenantId: string,
  svc: SupabaseClient,
): Promise<MemberIdentity | null> {
  try {
    const ctx = await tenantContextFromRequest(req);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
    if (!authUserId) return null;
    const { data: urow, error: uerr } = await svc
      .from("users")
      .select("id, email, role")
      .eq("auth_user_id", authUserId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    // Fail-safe (caller decides anon-vs-403) but observable: a valid session
    // that can't resolve a users.id is unexpected (tenantContextFromRequest
    // already verified membership), so surface it rather than silently degrading.
    if (uerr) console.error(`[chat] users.id lookup failed (tenant=${tenantId}): ${uerr.message}`);
    const u = urow as { id: string; email: string | null; role: string | null } | null;
    if (!u) return null;
    return { ctx, userId: u.id, authUserId, customerEmail: u.email, role: u.role };
  } catch {
    // Invalid/expired session, or an authenticated user who isn't a member
    // of this tenant.
    return null;
  }
}

// Resolve the turn's identity into a discriminated union. `taIdentity` (when
// non-null) means the POST handler already verified a tenant_owner/agent for TA
// mode — reuse it rather than re-resolving so handleChat can't disagree with
// what the 403 gate verified.
export async function resolveChatIdentity(args: {
  req: Request;
  tenantId: string;
  hasCredential: boolean;
  taIdentity: MemberIdentity | null;
  resolvedAnonSessionId: string | null;
  svc: SupabaseClient;
}): Promise<ChatIdentity> {
  const { req, tenantId, hasCredential, taIdentity, resolvedAnonSessionId, svc } = args;

  if (taIdentity) return { kind: "member", ...taIdentity };
  if (hasCredential) {
    // #860: null (invalid/expired session, non-member) → DEGRADE to anonymous.
    // Never hard-error a customer turn.
    const ident = await resolveMemberIdentity(req, tenantId, svc);
    if (ident) return { kind: "member", ...ident };
  }

  // Forge a minimal ctx for downstream helpers that only need tenant_id.
  const ctx: TenantContext = {
    tenant_id: tenantId,
    source: { kind: "http_request", user_id: resolvedAnonSessionId! },
  };
  return { kind: "anon", ctx, anonSessionId: resolvedAnonSessionId };
}
