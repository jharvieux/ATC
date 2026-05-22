// §18.11 — Coordinator portal tab pages.
//
// Each tab renders a distinct panel:
//   overview   — group stats, upcoming actions, cabin grid summary
//   invitees   — invitee table with RSVP state and mute/remove actions
//   edit       — group detail edit form (read-only if group.status = 'sailed')
//   preview-email — renders the GroupInvitation email template with live group data
//   forum      — embedded forum view with coordinator privileges enabled

import * as React from "react";
import { TenantOfRecordDisclosure } from "@/components/booking/TenantOfRecordDisclosure";

const VALID_TABS = ["overview", "invitees", "edit", "preview-email", "forum"] as const;
type Tab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ id: string; tab: string }>;
};

export default async function CoordinateTabPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id, tab } = await params;

  if (!VALID_TABS.includes(tab as Tab)) {
    return (
      <div style={{ color: "#dc2626" }}>
        <p>Unknown tab: <strong>{tab}</strong>. Valid tabs: {VALID_TABS.join(", ")}.</p>
      </div>
    );
  }

  return <TabContent groupId={id} tab={tab as Tab} />;
}

function TabContent({ groupId, tab }: { groupId: string; tab: Tab }): React.ReactElement {
  switch (tab) {
    case "overview":
      return <OverviewTab groupId={groupId} />;
    case "invitees":
      return <InviteesTab groupId={groupId} />;
    case "edit":
      return <EditTab groupId={groupId} />;
    case "preview-email":
      return <PreviewEmailTab groupId={groupId} />;
    case "forum":
      return <ForumTab groupId={groupId} />;
  }
}

function OverviewTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Overview</h2>
      <p style={{ color: "#6b7280", marginBottom: 24 }}>Group ID: {groupId}</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <StatCard label="Booked" value="—" color="#059669" />
        <StatCard label="Interested" value="—" color="#d97706" />
        <StatCard label="Not going" value="—" color="#6b7280" />
      </div>

      <div style={{ marginTop: 24, padding: 16, background: "#f9fafb", borderRadius: 8 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Quick actions</h3>
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <li>
            <a href={`/groups/${groupId}/coordinate/invitees`} style={{ color: "#6366f1", textDecoration: "none", fontSize: 14 }}>
              → Manage invitees
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/preview-email`} style={{ color: "#6366f1", textDecoration: "none", fontSize: 14 }}>
              → Preview invitation email
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/forum`} style={{ color: "#6366f1", textDecoration: "none", fontSize: 14 }}>
              → Open group forum
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}

function InviteesTab({ groupId: _groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Invitees</h2>
      <p style={{ color: "#6b7280", marginBottom: 16, fontSize: 14 }}>
        Invitee management — mute, remove, or view RSVP status for each invited traveler.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#374151", fontWeight: 600 }}>Name</th>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#374151", fontWeight: 600 }}>Email</th>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#374151", fontWeight: 600 }}>RSVP</th>
            <th style={{ textAlign: "left", padding: "8px 12px", color: "#374151", fontWeight: 600 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td colSpan={4} style={{ padding: "16px 12px", color: "#6b7280", textAlign: "center" }}>
              {/* TODO(prompt-24): load invitees via /api/groups/:id/invitations */}
              Loading invitees…
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function EditTab({ groupId: _groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Edit Group</h2>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        Edit group details. Fields are read-only after the group&apos;s sailing date has passed.
      </p>

      {/* §18.10 sailed read-only enforcement is checked at the API level in PATCH /api/groups/:id */}
      <form style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="Cruise Line" name="cruise_line" />
        <FormField label="Ship Name" name="ship_name" />
        <FormField label="Sailing Date" name="sailing_date" type="date" />
        <FormField label="Departure Port" name="departure_port" />
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>Coordinator Message</span>
          <textarea
            name="coordinator_message"
            rows={4}
            style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14, resize: "vertical" }}
            placeholder="Optional message shown on the invitation page…"
          />
        </label>
        <div>
          <button
            type="submit"
            style={{ padding: "10px 20px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 14 }}
          >
            Save Changes
          </button>
        </div>
      </form>
    </section>
  );
}

function PreviewEmailTab({ groupId: _groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Preview Invitation Email</h2>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        This is how the invitation email will appear to invitees.
      </p>

      {/* Renders the GroupInvitation email template with live group data */}
      {/* TODO(prompt-23): replace with live BrandedLayout email template render */}
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 24,
          background: "#fafafa",
          fontFamily: "Georgia, serif",
          lineHeight: 1.7,
        }}
      >
        <div style={{ maxWidth: 600, margin: "0 auto", background: "#fff", padding: "32px 40px", borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", marginBottom: 8 }}>
            You&apos;re invited to a group cruise!
          </h1>
          <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 24 }}>
            [Cruise Line] · [Ship Name] · [Sailing Date]
          </p>
          <p style={{ color: "#374151", marginBottom: 24 }}>
            [Coordinator message will appear here]
          </p>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <span style={{ display: "inline-block", padding: "12px 28px", background: "#6366f1", color: "#fff", borderRadius: 6, fontWeight: 600, fontSize: 15 }}>
              View Invitation &amp; RSVP
            </span>
          </div>
          <TenantOfRecordDisclosure
            tenant={{ name: "[Your Agency]", support_email: "support@youragency.com" }}
            hostAgency={{ legal_name: "[Host Agency Name]" }}
          />
        </div>
      </div>
    </section>
  );
}

function ForumTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Group Forum</h2>
      <p style={{ color: "#6b7280", marginBottom: 16, fontSize: 14 }}>
        Coordinator view — all message statuses visible. Use the message actions to hide, unhide, or flag content.
      </p>

      {/* §19.7 coordinator privileges: all statuses visible with action buttons */}
      {/* TODO(prompt-24): embed live forum component with coordinator=true prop */}
      <div style={{ padding: 24, background: "#f9fafb", borderRadius: 8, textAlign: "center", color: "#9ca3af" }}>
        Forum view for group <strong>{groupId}</strong> — forum component loads here (prompt-24).
      </div>
    </section>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }): React.ReactElement {
  return (
    <div style={{ background: "#f9fafb", borderRadius: 8, padding: 16, textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 13, color: "#6b7280" }}>{label}</div>
    </div>
  );
}

function FormField({
  label,
  name,
  type = "text",
}: {
  label: string;
  name: string;
  type?: string;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>{label}</span>
      <input
        type={type}
        name={name}
        style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
      />
    </label>
  );
}
