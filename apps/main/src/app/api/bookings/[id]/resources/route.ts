// BP39 §39.3 — Generate or fetch the trip resources page.

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { assertDeliverablesAvailable } from "@/lib/deliverables/tier-gate";
import { newAccessToken } from "@/lib/deliverables/token";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bookings.resources", action: "read" });
    const { id: bookingId } = await params;
    const svc = createServiceRoleClient();
    const { data, error } = await svc
      .from("trip_resources")
      .select("*")
      .eq("tenant_id", ctx.tenant_id)
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ resources: data ?? null });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bookings.resources", action: "create" });
    const { id: bookingId } = await params;
    const svc = createServiceRoleClient();

    const gate = await assertDeliverablesAvailable(ctx.tenant_id, svc);
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: 403 });

    const { data: existing } = await svc
      .from("trip_resources")
      .select("*")
      .eq("tenant_id", ctx.tenant_id)
      .eq("booking_id", bookingId)
      .maybeSingle();
    if (existing) return Response.json({ resources: existing, created: false });

    // Auto-populate agent contact snapshot per §39.3.5 / §39.10 "snapshot at publication time".
    const { data: agentRow } = await svc
      .from("users")
      .select("first_name, last_name, email, phone")
      .eq("id", user.id)
      .maybeSingle();
    const agent_contact = agentRow
      ? {
          name: [(agentRow as { first_name: string | null }).first_name, (agentRow as { last_name: string | null }).last_name]
            .filter(Boolean)
            .join(" "),
          email: (agentRow as { email: string | null }).email,
          phone: (agentRow as { phone: string | null }).phone,
        }
      : null;

    // §39.3.5 default sections — agent edits in CRM.
    const sections = [
      { section_label: "Cruise line", links: [] },
      { section_label: "Ports", links: [] },
      { section_label: "Travel advisories", links: [] },
      { section_label: "Insurance", links: [] },
      { section_label: "Other", links: [] },
    ];

    const { data: created, error } = await svc
      .from("trip_resources")
      .insert({
        tenant_id: ctx.tenant_id,
        booking_id: bookingId,
        access_token: newAccessToken(),
        status: "draft",
        sections,
        agent_contact,
      })
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ resources: created, created: true }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
