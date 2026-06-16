// §24.1 / §24.7 — List the caller's conversations.
//
// Returns the authenticated user's conversations in the resolved tenant,
// most-recent first. Anonymous chat conversations live in the anon-session
// and are not surfaced here (they're transferred per §11.6 on signup).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Chat conversations",
      action: "list",
    });
    const db = tenantClient(ctx);
    const authUserId = ctx.source.kind === "http_request" ? ctx.source.user_id : null;

    // #913: conversations.user_id stores public.users.id, not auth.users.id.
    // Resolve the mapping before filtering so the list returns the caller's
    // own threads rather than nothing (or all tenant threads if RLS allows).
    let publicUserId: string | null = null;
    if (authUserId) {
      const { data: urow, error: uErr } = await db
        .from("users")
        .select("id")
        .eq("auth_user_id", authUserId)
        .maybeSingle();
      if (uErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
      publicUserId = (urow as { id: string } | null)?.id ?? null;
    }

    // No public users row → no conversations to own. Return empty rather than
    // running an unfiltered query (which would return all tenant conversations).
    if (!publicUserId) {
      return Response.json({ conversations: [] });
    }

    // #902: customer listing only — TA-mode threads (audience='tenant_member')
    // have their own dashboard surface (PR B) and must not mix into customer
    // chat history.
    const q = db
      .from("conversations")
      .select("id, title, status, last_message_at, message_count, active_persona_id")
      .eq("audience", "customer")
      .eq("user_id", publicUserId)
      .order("last_message_at", { ascending: false })
      .limit(50);

    const { data, error } = await q;
    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ conversations: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}
