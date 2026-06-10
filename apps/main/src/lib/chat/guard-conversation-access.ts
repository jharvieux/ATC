// #908 / D-195 — member-level conversation access guard.
//
// Generalizes #902's TA-thread guard to ALL conversation rows: the routes
// run on tenantClient (service-role + injected tenant filter), so RLS never
// evaluates there — this guard IS the active member-isolation layer for any
// route that takes a conversation id (read, retitle, escalate, persona
// switch). The RLS policies from 20260629000003 are the DB-layer twin for
// future JWT-driven paths.
//
// Access rule (docs/security/908-conversation-member-isolation.md):
//   owner (conv.user_id = caller's public.users.id)
//   OR (staff role AND audience='customer').
// TA threads stay own-only even for tenant_owner (D-195). 404, never 403 —
// existence is not leaked. Fail closed: unresolvable caller → 404.

import type { TenantContext } from "@/lib/db/tenant-context";
import type { tenantClient } from "@/lib/db/tenant-client";

export interface ConversationAccessRow {
  audience: string;
  user_id: string | null;
}

const STAFF_ROLES = new Set(["tenant_owner", "agent"]);

export async function guardConversationAccess(
  db: ReturnType<typeof tenantClient>,
  ctx: TenantContext,
  conv: ConversationAccessRow,
): Promise<Response | null> {
  const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;
  if (!authUserId) return notFound();

  const { data: urow, error } = await db
    .from("users")
    .select("id, role")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error || !urow) return notFound();

  const callerId = (urow as { id: string }).id;
  const role = (urow as { role?: string }).role ?? "";

  if (conv.user_id === callerId) return null; // owner — covers TA + customer threads
  if (conv.audience === "customer" && STAFF_ROLES.has(role)) return null; // staff on customer threads

  return notFound();
}

function notFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404 });
}
