// BP37 §37.2 / §37.7 — Tasks list + create.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertAssignmentAllowed } from "@/lib/tasks/tier-gate";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const TaskCreateSchema = z
  .object({
    contact_id: z.string().uuid().optional(),
    quote_id: z.string().uuid().optional(),
    booking_id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    task_type: z.enum(["call", "email", "text", "meeting", "follow_up", "review", "document", "custom"]),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    due_at: z.string().datetime().optional(),
    due_is_all_day: z.boolean().optional(),
    assigned_to_user_id: z.string().uuid().optional(),
    reminder_offsets_minutes: z.array(z.number().int().nonnegative()).optional(),
  })
  .refine(
    (d) =>
      [d.contact_id, d.quote_id, d.booking_id, d.conversation_id].filter((v) => v != null).length === 1,
    { message: "Exactly one of contact_id/quote_id/booking_id/conversation_id is required" },
  );

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "tasks", action: "list" });
    const db = tenantClient(ctx);
    const url = new URL(req.url);

    const status = url.searchParams.getAll("status");
    const assignedToMe = url.searchParams.get("assigned_to_me") === "true";
    const contactId = url.searchParams.get("contact_id");
    const quoteId = url.searchParams.get("quote_id");
    const bookingId = url.searchParams.get("booking_id");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    let q = db
      .from("tasks")
      .select("*", { count: "exact" })
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(limit);

    if (status.length > 0) q = q.in("status", status);
    else q = q.in("status", ["open", "in_progress", "snoozed"]);
    if (assignedToMe) q = q.eq("assigned_to_user_id", user.id);
    if (contactId) q = q.eq("contact_id", contactId);
    if (quoteId) q = q.eq("quote_id", quoteId);
    if (bookingId) q = q.eq("booking_id", bookingId);

    const { data, count, error } = await q;
    if (error) return dbErrorResponse(error);
    return Response.json({ tasks: data ?? [], total: count ?? 0 });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "tasks", action: "create" });
    const db = tenantClient(ctx);
    const svc = createServiceRoleClient();

    const body = await req.json();
    const parsed = TaskCreateSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    // §37.10 tier gate: assigned_to_user_id requires assignment-allowed tier.
    if (parsed.data.assigned_to_user_id && parsed.data.assigned_to_user_id !== user.id) {
      const gate = await assertAssignmentAllowed(ctx.tenant_id, svc);
      if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });
    }

    const { reminder_offsets_minutes, ...taskFields } = parsed.data;
    const { data, error } = await db
      .from("tasks")
      .insert({
        ...taskFields,
        tenant_id: ctx.tenant_id,
        created_by_user_id: user.id,
        origin: "manual",
      })
      .select()
      .single();
    if (error) return dbErrorResponse(error);

    // Reminders.
    const created = data as { id: string; due_at: string | null };
    if (reminder_offsets_minutes && reminder_offsets_minutes.length > 0 && created.due_at) {
      const dueMs = Date.parse(created.due_at);
      const reminders = reminder_offsets_minutes.map((minutes) => ({
        tenant_id: ctx.tenant_id,
        task_id: created.id,
        remind_at: new Date(dueMs - minutes * 60 * 1000).toISOString(),
        channel: "in_app" as const,
      }));
      await safeAwait(db.from("task_reminders").insert(reminders), "task_reminders.insert");
    }

    return Response.json(data, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
