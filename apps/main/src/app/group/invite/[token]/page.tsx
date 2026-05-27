// §18.5 — Invitee canonical landing page.
// Validates the token server-side (five checks); renders group details,
// cabin grid, and RSVP buttons if valid.

import * as React from "react";

type PageProps = { params: Promise<{ token: string }> };

interface InviteData {
  invitation: { id: string; rsvp_state: string };
  group: {
    cruise_line: string;
    ship_name: string;
    sailing_date: string;
    departure_port: string;
    coordinator_message: string | null;
    hero_image_url: string | null;
    status: string;
  };
  cabin_grid: { booked: number; interested: number; pending: number; not_going: number };
}

async function fetchInviteData(token: string, origin: string): Promise<{ data?: InviteData; error?: string; reason?: string }> {
  const res = await fetch(`${origin}/api/groups/invite/${encodeURIComponent(token)}`, { cache: "no-store" });
  const body = await res.json() as InviteData & { error?: string; reason?: string };
  if (!res.ok) {
    const result: { data?: InviteData; error?: string; reason?: string } = { error: body.error ?? "unknown_error" };
    if (body.reason !== undefined) result.reason = body.reason;
    return result;
  }
  return { data: body };
}

export default async function InvitePage(props: PageProps): Promise<React.ReactElement> {
  const params = await props.params;
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    : "http://localhost:3000";

  const { data, error, reason } = await fetchInviteData(params.token, origin);

  if (error) {
    return (
      <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 16, fontFamily: "system-ui, sans-serif", padding: 32 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#dc2626" }}>Invitation unavailable</h1>
        <p style={{ color: "#6b7280", maxWidth: 400, textAlign: "center" }}>
          {reason === "expired_natural"
            ? "This invitation has expired."
            : reason === "invitee_removed"
            ? "You have been removed from this trip invitation."
            : "This invitation link is invalid or has been revoked. Please contact the trip coordinator."}
        </p>
      </main>
    );
  }

  if (!data) return <main><p>Loading…</p></main>;

  const { group, invitation, cabin_grid } = data;
  const isSailed = group.status === "sailed";

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "32px 16px", fontFamily: "system-ui, sans-serif" }}>
      {group.hero_image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        (<img src={group.hero_image_url} alt={group.departure_port} style={{ width: "100%", borderRadius: 12, marginBottom: 24, maxHeight: 300, objectFit: "cover" }} />)
      )}
      <h1 style={{ fontSize: 26, fontWeight: 700, marginBottom: 4 }}>{group.cruise_line} — {group.ship_name}</h1>
      <p style={{ color: "#6b7280", marginBottom: 24 }}>
        Sailing {new Date(group.sailing_date).toLocaleDateString("en-US", { dateStyle: "long" })} · {group.departure_port}
      </p>
      {group.coordinator_message && (
        <blockquote style={{ margin: "0 0 24px", padding: "16px 20px", background: "#f9fafb", borderLeft: "4px solid #6366f1", fontFamily: "Georgia, serif", fontSize: 15, lineHeight: 1.7 }}>
          {group.coordinator_message}
        </blockquote>
      )}
      {/* Cabin grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 32 }}>
        <StatCard label="Booked" value={cabin_grid.booked} color="#059669" />
        <StatCard label="Interested" value={cabin_grid.interested} color="#d97706" />
        <StatCard label="Pending" value={cabin_grid.pending} color="#6b7280" />
      </div>
      {/* RSVP buttons — disabled if sailed */}
      {!isSailed && (
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Your RSVP</h2>
          <RsvpButtons token={params.token} current={invitation.rsvp_state} />
        </div>
      )}
      {isSailed && (
        <p style={{ color: "#6b7280", fontStyle: "italic" }}>This group has sailed — the page is now read-only.</p>
      )}
    </main>
  );
}

function StatCard(props: { label: string; value: number; color: string }): React.ReactElement {
  return (
    <div style={{ background: "#f9fafb", borderRadius: 8, padding: "16px", textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: props.color }}>{props.value}</div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>{props.label}</div>
    </div>
  );
}

function RsvpButtons(props: { token: string; current: string }): React.ReactElement {
  const options: { state: string; label: string }[] = [
    { state: "interested", label: "I'm interested" },
    { state: "not_going", label: "Can't make it" },
    { state: "booked", label: "I've booked" },
  ];
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <form key={opt.state} method="POST" action={`/api/groups/invite/${props.token}/rsvp`}>
          <input type="hidden" name="rsvp_state" value={opt.state} />
          <button
            type="submit"
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: props.current === opt.state ? "2px solid #6366f1" : "1px solid #d1d5db",
              background: props.current === opt.state ? "#eef2ff" : "#fff",
              fontWeight: props.current === opt.state ? 700 : 400,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {opt.label}
          </button>
        </form>
      ))}
    </div>
  );
}
