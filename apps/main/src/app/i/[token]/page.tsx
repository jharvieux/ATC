// BP39 §39.2.6 — Public itinerary view by tokenized URL.
//
// Server component. Looks up by access_token (status != 'draft'),
// renders a minimal tenant-branded page with the booking details + agent
// notes. Records an audit_log entry for the agent's "who viewed" trail.

import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";
import { headers } from "next/headers";

interface PageProps {
  params: Promise<{ token: string }>;
}

type ItineraryRow = {
  id: string;
  tenant_id: string;
  booking_id: string;
  status: string;
  agent_notes: string | null;
  bookings:
    | {
        cruise_line: string | null;
        ship_name: string | null;
        sailing_date: string | null;
        duration_nights: number | null;
        cabin_category: string | null;
        departure_port: string | null;
        primary_contact_id: string | null;
      }
    | Array<{
        cruise_line: string | null;
        ship_name: string | null;
        sailing_date: string | null;
        duration_nights: number | null;
        cabin_category: string | null;
        departure_port: string | null;
        primary_contact_id: string | null;
      }>
    | null;
  tenants:
    | { display_name: string | null }
    | { display_name: string | null }[]
    | null;
};

export default async function PublicItineraryPage({ params }: PageProps): Promise<JSX.Element> {
  const { token } = await params;
  const svc = createServiceRoleClient();

  const { data, error } = await svc
    .from("trip_itineraries")
    .select(
      "id, tenant_id, booking_id, status, agent_notes, bookings(cruise_line, ship_name, sailing_date, duration_nights, cabin_category, departure_port, primary_contact_id), tenants(display_name)",
    )
    .eq("access_token", token)
    .neq("status", "draft")
    .maybeSingle();
  if (error || !data) notFound();

  const row = data as ItineraryRow;
  const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;

  if (!booking) notFound();

  // Audit who viewed.
  const h = await headers();
  await writeAuditLog({
    tenant_id: row.tenant_id,
    actor_type: "system",
    action: "itinerary.viewed",
    resource_type: "trip_itinerary",
    resource_id: row.id,
    context: {
      ip: h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? null,
      user_agent: h.get("user-agent") ?? null,
    },
  });

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "32px 24px", fontFamily: "system-ui" }}>
      <header style={{ borderBottom: "2px solid #1f4e79", paddingBottom: 16, marginBottom: 24 }}>
        <div style={{ color: "#1f4e79", fontWeight: 600 }}>{tenant?.display_name ?? ""}</div>
        <h1 style={{ margin: "8px 0 4px", fontSize: 28 }}>
          {booking.cruise_line} {booking.ship_name}
        </h1>
        <div style={{ color: "#555" }}>
          {booking.sailing_date} · {booking.duration_nights ?? "?"} nights · {booking.cabin_category ?? "Cabin TBD"}
        </div>
      </header>

      <section>
        <h2 style={{ color: "#1f4e79" }}>At a glance</h2>
        <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 4 }}>
          <dt style={{ color: "#666" }}>Embarkation</dt>
          <dd style={{ margin: 0 }}>{booking.departure_port ?? "—"}</dd>
          <dt style={{ color: "#666" }}>Sail date</dt>
          <dd style={{ margin: 0 }}>{booking.sailing_date ?? "—"}</dd>
          <dt style={{ color: "#666" }}>Cabin</dt>
          <dd style={{ margin: 0 }}>{booking.cabin_category ?? "—"}</dd>
        </dl>
      </section>

      {row.agent_notes && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ color: "#1f4e79" }}>From your agent</h2>
          <p style={{ whiteSpace: "pre-wrap" }}>{row.agent_notes}</p>
        </section>
      )}

      <footer style={{ marginTop: 48, borderTop: "1px solid #ddd", paddingTop: 16, color: "#888", fontSize: 13 }}>
        Your travel agent will be in touch with updates.
      </footer>
    </main>
  );
}
