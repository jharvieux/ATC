// §11.3 — Customer memory controls API.
// GET  /api/memory — return the caller's customer_memories row for the active tenant.
// PATCH /api/memory — partial update of memory fields (agent-initiated correction).
// DELETE /api/memory — clear all JSONB memory columns (keeps the row for FK integrity).

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const MemoryPatchSchema = z.object({
  preferences: z.record(z.unknown()).nullable().optional(),
  travel_history: z.record(z.unknown()).nullable().optional(),
  family_composition: z.array(z.unknown()).nullable().optional(),
  accessibility_needs: z.record(z.unknown()).nullable().optional(),
  dietary_restrictions: z.record(z.unknown()).nullable().optional(),
  loyalty_programs: z.array(z.unknown()).nullable().optional(),
  important_dates: z.record(z.unknown()).nullable().optional(),
  notes_freeform: z.string().nullable().optional(),
  rapport_tone_level: z.number().int().min(1).max(5).nullable().optional(),
  rapport_signals: z.record(z.unknown()).nullable().optional(),
}).strict();

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "CustomerMemory",
      action: "read",
    });
    const db = tenantClient(ctx);

    const { data, error } = await db
      .from("customer_memories")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!data) return Response.json(null, { status: 200 });

    return Response.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "CustomerMemory",
      action: "update",
    });

    const body: unknown = await req.json();
    const parsed = MemoryPatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid request body", issues: parsed.error.issues }, { status: 400 });
    }

    const db = tenantClient(ctx);
    const now = new Date().toISOString();

    // Upsert so a missing row is created on agent-initiated correction.
    const { data, error } = await db
      .from("customer_memories")
      .upsert(
        { user_id: user.id, ...parsed.data, updated_at: now },
        { onConflict: "tenant_id,user_id" },
      )
      .select("id, updated_at")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // Audit-log the update (stub until §26 audit_log table lands).
    console.warn("[audit-log:STUB]", JSON.stringify({
      action: "customer_memory.updated",
      tenant_id: ctx.tenant_id,
      user_id: user.id,
      fields_changed: Object.keys(parsed.data),
      ts: now,
    }));

    return Response.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, {
      resource: "CustomerMemory",
      action: "delete",
    });
    const db = tenantClient(ctx);
    const now = new Date().toISOString();

    // Clear JSONB columns only — keep the row for FK integrity per §11.3.
    const { error } = await db
      .from("customer_memories")
      .update({
        preferences: null,
        travel_history: null,
        family_composition: null,
        accessibility_needs: null,
        dietary_restrictions: null,
        loyalty_programs: null,
        important_dates: null,
        notes_freeform: null,
        rapport_tone_level: null,
        rapport_signals: null,
        updated_at: now,
      })
      .eq("user_id", user.id);

    if (error) return Response.json({ error: error.message }, { status: 500 });

    console.warn("[audit-log:STUB]", JSON.stringify({
      action: "customer_memory.cleared",
      tenant_id: ctx.tenant_id,
      user_id: user.id,
      ts: now,
    }));

    return new Response(null, { status: 204 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 401 });
  }
}
