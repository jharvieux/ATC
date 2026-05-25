// §24.4 — Submit chat feedback (thumbs up/down + optional reason).
//
// Body: { message_id: string, score: -1|0|1, reason?: string }.
// Writes feedback_score and feedback_reason on the messages row. The §6.10
// authority-loop nudges (RAG side) consume this signal via the existing
// retrieve/authority pipeline.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Chat feedback",
      action: "post",
    });
    const body = (await req.json()) as {
      message_id?: string;
      score?: number;
      reason?: string;
    };

    const messageId = String(body.message_id ?? "");
    const score = Number(body.score);
    if (!messageId) return Response.json({ error: "missing_message_id" }, { status: 400 });
    if (![-1, 0, 1].includes(score)) {
      return Response.json({ error: "invalid_score" }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const { error } = await db
      .from("messages")
      .update({
        feedback_score: score,
        feedback_reason: body.reason?.toString().slice(0, 1000) ?? null,
      })
      .eq("id", messageId);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
