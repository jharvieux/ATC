// §10.6 AI Kill Switch API — global pause/resume
//
// POST /api/admin/ai-kill-switch
// Body: { paused: boolean, reason?: string }
//
// Requires platform-admin. Wraps the update in withPlatformAdminAudit with
// reason "ai_kill_switch_global_pause" or "ai_kill_switch_global_resume".
//
// The supervisor reads ai_kill_switch_state on every chat turn with a cache
// TTL ≤ 30 seconds (caching implemented at the read site, not here).
// When global_paused = true, the supervisor returns action='escalate' and
// the chat path surfaces: "Our AI is taking a brief break. A human will be
// in touch shortly." (§10.6)

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import type { PlatformAdminReason } from "@/lib/db/platform-admin-reasons";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "ai_kill_switch")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>).paused !== "boolean"
  ) {
    return Response.json(
      { error: "paused (boolean) is required" },
      { status: 400 },
    );
  }

  const { paused, reason } = body as { paused: boolean; reason?: string };
  const adminReason: PlatformAdminReason = paused
    ? "ai_kill_switch_global_pause"
    : "ai_kill_switch_global_resume";

  try {
    const result = await withPlatformAdminAudit(
      {
        admin_user_id: adminUserId,
        reason: adminReason,
        operation: paused ? "global_ai_pause" : "global_ai_resume",
        reason_detail: reason ?? (paused ? "manual_pause" : "manual_resume"),
      },
      async (db) => {
        const { data, error } = await db
          .from("ai_kill_switch_state")
          .update({
            global_paused: paused,
            global_paused_at: paused ? new Date().toISOString() : null,
            global_paused_by_user_id: paused ? adminUserId : null,
            global_paused_reason: paused ? (reason ?? null) : null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", 1)
          .select()
          .single();

        if (error) throw new Error(error.message);
        return data;
      },
    );

    return Response.json({ ok: true, state: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal_error";
    return Response.json({ error: message }, { status: 500 });
  }
}
