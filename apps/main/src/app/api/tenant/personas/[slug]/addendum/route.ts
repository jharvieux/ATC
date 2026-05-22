// §16.6 — Persona addendum upsert API (Agency tier).
// POST/PUT: insert or replace an addendum for the current tenant + persona slug.
// Every save resets status to pending_screen and triggers the Haiku screen job.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { inngest } from "@/inngest/client";

interface AddendumBody {
  content: string;
}

const MAX_LEN = 2000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug: personaSlug } = await params;

  let auth;
  try {
    auth = await assertPermission(req, { resource: "persona_addendum", action: "write" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
  const { ctx } = auth;

  let body: AddendumBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const content = (body.content ?? "").trim();
  if (!content) return Response.json({ error: "content_required" }, { status: 422 });
  if (content.length > MAX_LEN) {
    return Response.json({ error: "content_too_long", max: MAX_LEN }, { status: 422 });
  }

  // Detect unusual control characters per §16.6 (cheap pre-check; Haiku does the deeper screen).
  // Strip ordinary whitespace (\t, \n, \r) from the test; flag any other C0/C1 chars.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‏‪-‮⁠-⁤]/.test(content)) {
    return Response.json({ error: "control_characters_disallowed" }, { status: 422 });
  }

  const db = tenantClient(ctx);

  const { data: row, error } = await db
    .from("persona_addendums")
    .upsert(
      {
        persona_slug: personaSlug,
        content,
        status: "pending_screen",
        haiku_screen_result: null,
        haiku_screened_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,persona_slug" },
    )
    .select("id")
    .single();

  if (error || !row) {
    return Response.json({ error: error?.message ?? "upsert_failed" }, { status: 500 });
  }

  const addendumId = (row as { id: string }).id;

  // Trigger Haiku screen.
  await inngest.send({
    name: "persona_addendum.submitted",
    data: { tenant_id: ctx.tenant_id, persona_slug: personaSlug, addendum_id: addendumId },
  });

  return Response.json({ ok: true, addendum_id: addendumId, status: "pending_screen" });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug: personaSlug } = await params;

  let auth;
  try {
    auth = await assertPermission(req, { resource: "persona_addendum", action: "read" });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
  const { ctx } = auth;

  const db = tenantClient(ctx);
  const { data, error } = await db
    .from("persona_addendums")
    .select("id, content, status, haiku_screen_result, haiku_screened_at, updated_at")
    .eq("persona_slug", personaSlug)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ addendum: data ?? null });
}
