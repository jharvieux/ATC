// BP31 §32.6.2 — Open a Help AI session.
//
// Body: { session_type: 'help'|'bug'|'feature', source_surface: 'admin'|'customer_chat' }
// Returns: { session_id }
//
// Writes a help_sessions row + emits `help.session_opened` for any
// downstream subscribers (BP32 will subscribe for abuse-rate tracking).

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { inngest } from "@/inngest/client";

interface OpenSessionBody {
  session_type?: string;
  source_surface?: string;
  conversation_id?: string | null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "help_session", action: "create" });
    const body = (await req.json().catch(() => ({}))) as OpenSessionBody;

    const session_type = body.session_type;
    const source_surface = body.source_surface ?? "admin";
    if (session_type !== "help" && session_type !== "bug" && session_type !== "feature") {
      return Response.json(
        { error: "invalid_session_type", message: "session_type must be one of help|bug|feature" },
        { status: 400 },
      );
    }
    if (source_surface !== "admin" && source_surface !== "customer_chat") {
      return Response.json(
        { error: "invalid_source_surface", message: "source_surface must be one of admin|customer_chat" },
        { status: 400 },
      );
    }

    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("help_sessions")
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: user.id,
        session_type,
        source_surface,
        conversation_id: body.conversation_id ?? null,
      })
      .select("id")
      .single();
    if (error || !data) {
      return Response.json({ error: "db_error", message: error?.message ?? "unknown" }, { status: 500 });
    }

    const session = data as { id: string };

    await writeAuditLog({
      tenant_id: ctx.tenant_id,
      actor_user_id: user.id,
      actor_type: "user",
      action: "help.session_opened",
      resource_type: "help_session",
      resource_id: session.id,
      changes: { session_type, source_surface },
    });

    await inngest.send({
      name: "help.session_opened",
      data: { tenant_id: ctx.tenant_id, session_id: session.id, session_type, source_surface },
    });

    return Response.json({ session_id: session.id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}
