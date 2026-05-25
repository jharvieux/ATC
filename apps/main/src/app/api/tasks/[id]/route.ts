// BP37 §37.2 — Task PATCH (status/snooze/edit) + DELETE.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";

const TaskPatchSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["open", "in_progress", "completed", "snoozed", "cancelled"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  due_at: z.string().datetime().nullable().optional(),
  snoozed_until: z.string().datetime().nullable().optional(),
  assigned_to_user_id: z.string().uuid().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx } = await assertPermission(req, { resource: "tasks", action: "update" });
  const { id } = await params;
  const db = tenantClient(ctx);

  const body = await req.json();
  const parsed = TaskPatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
  }

  const update: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  if (parsed.data.status === "completed") {
    update.completed_at = new Date().toISOString();
  }

  const { data, error } = await db.from("tasks").update(update).eq("id", id).select().single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json(data);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { ctx } = await assertPermission(req, { resource: "tasks", action: "delete" });
  const { id } = await params;
  const db = tenantClient(ctx);
  const { error } = await db.from("tasks").delete().eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ deleted: true });
}
