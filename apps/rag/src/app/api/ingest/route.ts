// §8.5 — POST /api/ingest
//
// Scope rules:
//   scope='global'  → service_identifier must be 'platform-admin'
//   scope='tenant'  → body.tenant_id must match ctx.tenant_id (JWT is authoritative)
//
// PII gate (§6.11 / §22.4): zero-tolerance patterns are quarantined immediately.
// The Haiku redaction pass for tolerable PII is a later step — TODO(§22.4-haiku-redaction).

import { withServiceAuth } from "@/lib/auth/with-service-auth";
import { getRagDb } from "@/lib/db/supabase";
import { IngestRequestSchema } from "@/lib/schemas/retrieve";
import { detectZeroTolerancePII } from "@/lib/pii/regex-prefilter";

export const POST = withServiceAuth(async (req, ctx) => {
  // JWT scope must be 'write'
  if (ctx.scope !== "write") {
    return Response.json({ error: "insufficient_scope" }, { status: 403 });
  }

  let body: ReturnType<typeof IngestRequestSchema.parse>;
  try {
    const raw = await req.json();
    body = IngestRequestSchema.parse(raw);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Scope rules
  if (body.scope === "global") {
    if (ctx.service_identifier !== "platform-admin") {
      return Response.json({ error: "global_ingest_requires_platform_admin" }, { status: 403 });
    }
  } else {
    if (body.tenant_id !== ctx.tenant_id) {
      return Response.json({ error: "tenant_id_mismatch_with_jwt" }, { status: 403 });
    }
  }

  // PII pre-filter (§6.11)
  const piiResult = detectZeroTolerancePII(body.raw_content);
  if (piiResult.detected) {
    const db = getRagDb();
    const { data: row, error } = await db
      .from("knowledge_ingestion_queue")
      .insert({
        raw_content: body.raw_content,
        raw_source_url: body.source_url ?? null,
        raw_source_type: body.source_type,
        raw_metadata: { category: body.category, pii_categories: piiResult.categories },
        submitted_by_user_id: ctx.user_id ?? null,
        submitted_by_tenant_id: ctx.tenant_id,
        scope_intent: body.scope,
        processing_stage: "quarantined",
        failure_reason: `zero_tolerance_pii_detected: ${piiResult.categories.join(", ")}`,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[ingest] quarantine insert failed:", error);
      return Response.json({ error: "ingest_internal_error" }, { status: 500 });
    }

    return Response.json(
      { status: "quarantined", queue_item_id: row.id, reason: "zero_tolerance_pii_detected" },
      { status: 422 },
    );
  }

  // Clean content → pending_review
  const db = getRagDb();
  const { data: row, error } = await db
    .from("knowledge_ingestion_queue")
    .insert({
      raw_content: body.raw_content,
      raw_source_url: body.source_url ?? null,
      raw_source_type: body.source_type,
      raw_metadata: {
        category: body.category,
        cruise_line: body.cruise_line,
        ship: body.ship,
        destination: body.destination,
        agent_scope: body.agent_scope,
        tags: body.tags,
        contains_pricing: body.contains_pricing,
      },
      submitted_by_user_id: ctx.user_id ?? null,
      submitted_by_tenant_id: ctx.tenant_id,
      scope_intent: body.scope,
      processing_stage: "pending_review",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[ingest] pending_review insert failed:", error);
    return Response.json({ error: "ingest_internal_error" }, { status: 500 });
  }

  return Response.json({ queue_item_id: row.id, status: "pending_review" });
});
