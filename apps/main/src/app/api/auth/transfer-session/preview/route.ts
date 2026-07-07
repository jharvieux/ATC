// §11.6 — anonymous→authenticated transfer preview.
//
// GET /api/auth/transfer-session/preview?session=<uuid>
//
// Returns enough context for the consent UI to show the user what they're
// about to attach to their account: message_count, time_span, and the first
// three message previews (truncated).
//
// Two-layer tenant isolation:
//   1. assertPermission scopes the caller's ctx to the resolved tenant.
//   2. The anonymous_sessions row read is .eq("tenant_id", ctx.tenant_id),
//      and we return the same 404 whether the row is missing or belongs to
//      another tenant (don't leak cross-tenant existence).
//
// Service-role for anonymous_sessions / messages — RLS on those tables is
// USING (FALSE) (see anonymous-limit.ts), so a user-scoped client can't
// read them; the explicit tenant filter above supplies isolation.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const QuerySchema = z.object({ session: z.string().uuid() });

const PREVIEW_LIMIT = 3;
const PREVIEW_MAX_LEN = 120;

interface MessageRow {
  content: string | null;
  role: string | null;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "SessionTransfer",
      action: "preview",
    });

    const sessionParam = new URL(req.url).searchParams.get("session");
    const parsed = QuerySchema.safeParse({ session: sessionParam });
    if (!parsed.success) {
      return Response.json({ error: "invalid_session_id" }, { status: 400 });
    }
    const anonymous_session_id = parsed.data.session;

    const svc = createServiceRoleClient();

    const { data: session, error: sessionErr } = await svc
      .from("anonymous_sessions")
      .select("id, tenant_id")
      .eq("id", anonymous_session_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();
    if (sessionErr) {
      return Response.json(
        { error: "session_lookup_failed" },
        { status: 500 },
      );
    }
    if (!session) {
      return Response.json({ error: "session_not_found" }, { status: 404 });
    }

    // Messages have no anonymous_session_id column — they belong to a session
    // transitively through their conversation. Resolve the session's
    // conversations first, then pull their messages.
    const { data: convs, error: convsErr } = await svc
      .from("conversations")
      .select("id")
      .eq("anonymous_session_id", anonymous_session_id)
      .eq("tenant_id", ctx.tenant_id);
    if (convsErr) {
      return Response.json(
        { error: "conversations_lookup_failed" },
        { status: 500 },
      );
    }
    const convIds = (convs ?? []).map((c) => (c as { id: string }).id);

    // Pull user-authored messages only — assistant responses make poor
    // previews and pad the count with non-content. Ordered ascending so
    // the first three previews are the start of the conversation, with
    // the time_span computed from the full window.
    let rows: MessageRow[] = [];
    if (convIds.length > 0) {
      const { data: msgs, error: msgsErr } = await svc
        .from("messages")
        .select("content, role, created_at")
        .in("conversation_id", convIds)
        .eq("tenant_id", ctx.tenant_id)
        .eq("role", "user")
        .order("created_at", { ascending: true });
      if (msgsErr) {
        return Response.json(
          { error: "messages_lookup_failed" },
          { status: 500 },
        );
      }
      rows = (msgs ?? []) as MessageRow[];
    }

    const message_count = rows.length;
    const time_span =
      rows.length > 0
        ? {
            from: rows[0]!.created_at,
            to: rows[rows.length - 1]!.created_at,
          }
        : null;
    const message_previews = rows.slice(0, PREVIEW_LIMIT).map((r) => ({
      preview: truncate(r.content ?? "", PREVIEW_MAX_LEN),
      created_at: r.created_at,
    }));

    return Response.json({
      anonymous_session_id,
      message_count,
      time_span,
      message_previews,
    });
  } catch (err) {
    return respondToAuthError(err);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
