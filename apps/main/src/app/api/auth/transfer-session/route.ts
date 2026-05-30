// §11.6 — anonymous→authenticated transfer commit/discard.
//
// POST /api/auth/transfer-session  { anonymous_session_id, action }
//
// action="commit"  → softCommitTransfer (24h reversible window; re-keys
//                    conversations + messages to the authenticated user,
//                    schedules the finalize Inngest event with 24h delay).
//                    Undo via /api/auth/transfer-session/undo within 24h.
// action="discard" → user explicitly chose "start fresh"; nothing to
//                    re-key, but we clear the atc-anon-session cookie so
//                    the next chat message starts a new anonymous session.
//                    The orphaned anonymous_sessions row gets reaped by
//                    the existing TTL cleanup Inngest job.
//
// The two actions are separate semantic operations (D-091 §"one
// assertPermission per semantic operation"), so we parse the body, pick
// the action, and assertPermission against that exact action — never with
// a placeholder like "post".
//
// Service-role for the anonymous_sessions update: the table has
// FOR ... USING (FALSE) RLS (see anonymous-limit.ts) so RLS can't grant a
// user-scoped client; the (session.tenant_id === ctx.tenant_id) check
// supplies the two-layer isolation.

import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { softCommitTransfer } from "@/lib/transfer/anon-to-auth";

const ANON_SESSION_COOKIE = "atc-anon-session";

const BodySchema = z
  .object({
    anonymous_session_id: z.string().uuid(),
    action: z.enum(["commit", "discard"]),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body: unknown = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    const { anonymous_session_id, action } = parsed.data;

    const { ctx, user } = await assertPermission(req, {
      resource: "SessionTransfer",
      action,
    });

    const svc = createServiceRoleClient();

    // Verify the named session belongs to this tenant. Same response shape
    // whether the row doesn't exist or belongs to another tenant (don't leak
    // cross-tenant existence).
    const { data: session, error: readErr } = await svc
      .from("anonymous_sessions")
      .select("id, tenant_id, transferred_to_user_id, transfer_soft_commit_at")
      .eq("id", anonymous_session_id)
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (readErr) {
      return Response.json(
        { error: "session_lookup_failed" },
        { status: 500 },
      );
    }
    if (!session) {
      return Response.json({ error: "session_not_found" }, { status: 404 });
    }
    const row = session as {
      id: string;
      tenant_id: string;
      transferred_to_user_id: string | null;
      transfer_soft_commit_at: string | null;
    };

    // Idempotency: if this user already soft-committed, re-running commit is a
    // no-op success; running discard after a soft-commit is a 409 (the
    // recipient should use /undo to revert, not /discard).
    if (row.transferred_to_user_id && row.transferred_to_user_id !== user.id) {
      return Response.json(
        { error: "session_owned_by_other_user" },
        { status: 403 },
      );
    }

    if (action === "commit") {
      if (row.transferred_to_user_id === user.id && row.transfer_soft_commit_at) {
        return Response.json({ status: "soft_committed", idempotent: true });
      }
      const result = await softCommitTransfer({
        db: svc,
        anonymous_session_id: row.id,
        user_id: user.id,
        tenant_id: ctx.tenant_id,
      });
      return Response.json(result);
    }

    // action === "discard"
    if (row.transfer_soft_commit_at) {
      return Response.json(
        { error: "transfer_already_in_progress" },
        { status: 409 },
      );
    }
    const res = NextResponse.json({ status: "discarded" });
    // "Start fresh" — clear the anon-session cookie so the next chat message
    // creates a new anonymous_sessions row instead of reusing this one.
    res.cookies.set({
      name: ANON_SESSION_COOKIE,
      value: "",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (err) {
    return respondToAuthError(err);
  }
}
