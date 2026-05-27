// §24.6 — Switch the active persona for a conversation.
//
// Body: { persona_slug: string }. Updates conversations.active_persona_id
// and writes a system message into the transcript so the new persona's first
// reply (next POST /api/chat) starts with the context the spec describes.
// Generating the actual context summary is deferred to the next AI turn; this
// endpoint just records the switch.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";

const KNOWN_SLUGS = new Set([
  "marcus-cole",
  "marco-bellini",
  "priya-sharma",
  "captain-dave",
  "maya-patel",
  "jenny-hartwell",
]);

export async function POST(
  req: Request,
  ctxParams: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "Switch persona",
      action: "post",
    });
    const { id } = await ctxParams.params;
    const body = (await req.json()) as { persona_slug?: string };
    const slug = String(body.persona_slug ?? "");
    if (!KNOWN_SLUGS.has(slug)) {
      return Response.json({ error: "unknown_persona_slug" }, { status: 400 });
    }

    const db = tenantClient(ctx);

    // Persist the switch as a system transcript line so the chat handler's
    // next turn can pick it up and generate the context summary in-character.
    await safeAwait(db.from("messages").insert({
      conversation_id: id,
      role: "system",
      content: `[persona_switch] active_persona_slug=${slug}`,
    }), "messages.insert");
    const { error } = await db
      .from("conversations")
      // active_persona_id is a TODO(personas-fk) UUID column — until the
      // personas table exists we store a deterministic UUID derived from
      // the slug. For now we leave the field null and let the chat handler
      // read the slug from the most recent [persona_switch] system message.
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return Response.json({ error: error.message }, { status: 500 });

    return Response.json({ ok: true, active_persona_slug: slug });
  } catch (err) {
    return respondToAuthError(err);
  }
}
