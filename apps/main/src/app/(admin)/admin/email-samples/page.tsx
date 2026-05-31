"use client";

// #489 — Platform admin email sample sender.
// Renders any pre-cruise or group template to HTML and optionally sends it
// via Resend so admins can verify design and deliverability.

import { useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";
import { listRegionImageCoverage } from "@/lib/cruise-regions/destination-images";

const TEMPLATE_OPTIONS = [
  { value: "T90", label: "Pre-cruise T-90 (Anticipation Begins)" },
  { value: "T30", label: "Pre-cruise T-30 (Final Prep)" },
  { value: "T7",  label: "Pre-cruise T-7 (Almost There)" },
  { value: "T1",  label: "Pre-cruise T-1 (Tomorrow!)" },
  { value: "GroupInvitation", label: "Group Invitation" },
  { value: "GroupBroadcast",  label: "Group Broadcast" },
] as const;

const REGION_OPTIONS = listRegionImageCoverage().map(({ region, has_image }) => ({
  value: region,
  label: `${region.replace(/_/g, " ")}${has_image ? "" : " (no hero image)"}`,
}));

const DEFAULT_PORTS = "Miami, FL\nAt sea\nRoatán, Honduras\nHarvest Caye\nCosta Maya\nCozumel\nAt sea";
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_SAILING_DATE = new Date(Date.now() + NINETY_DAYS_MS).toISOString().slice(0, 10);

export default function EmailSamplesPage() {
  const [template, setTemplate]               = useState<string>("T90");
  const [toEmail, setToEmail]                 = useState("");
  const [customerName, setCustomerName]       = useState("Jordan");
  const [shipName, setShipName]               = useState("Norwegian Bliss");
  const [cruiseLine, setCruiseLine]           = useState("Norwegian Cruise Line");
  const [sailingDate, setSailingDate]         = useState(DEFAULT_SAILING_DATE);
  const [region, setRegion]                   = useState("caribbean");
  const [ports, setPorts]                     = useState(DEFAULT_PORTS);
  const [companionUrl, setCompanionUrl]       = useState("https://example.com/companion");

  // Group-specific fields
  const [groupName, setGroupName]             = useState("Our Group Cruise");
  const [inviteeName, setInviteeName]         = useState("Alex");
  const [coordinatorMsg, setCoordinatorMsg]   = useState("We're so excited you can join us!");
  const [inviteUrl, setInviteUrl]             = useState("https://example.com/group/invite/token");
  const [broadcastSubject, setBroadcastSubject] = useState("Update from your group coordinator");
  const [broadcastMessage, setBroadcastMessage] = useState("Hello everyone! Just a quick update from your coordinator.\n\nLooking forward to seeing you on board!");

  const [sending, setSending]   = useState(false);
  const [result, setResult]     = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const isGroup = template === "GroupInvitation" || template === "GroupBroadcast";

  function buildParams(): Record<string, string> {
    const base: Record<string, string> = {
      template,
      customer_name: customerName,
      ship_name: shipName,
      cruise_line: cruiseLine,
      sailing_date: new Date(sailingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      ports,
      destination_region: region,
      companion_page_url: companionUrl,
    };
    if (isGroup) {
      base.group_name         = groupName;
      base.invitee_name       = inviteeName;
      base.coordinator_message = coordinatorMsg;
      base.invite_url         = inviteUrl;
      base.broadcast_subject  = broadcastSubject;
      base.broadcast_message  = broadcastMessage;
    }
    return base;
  }

  function handlePreview() {
    const params = new URLSearchParams(buildParams());
    window.open(`/api/admin/email-samples?${params.toString()}`, "_blank");
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!toEmail) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const res = await adminFetch("/api/admin/email-samples", {
        method: "POST",
        body: JSON.stringify({ ...buildParams(), to_email: toEmail }),
      });
      const json = await res.json() as { ok?: boolean; resend_message_id?: string; error?: string };
      if (!res.ok) {
        setError(json.error ?? `Send failed (${res.status})`);
      } else {
        setResult(`Sent! Resend ID: ${json.resend_message_id ?? "(none)"}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSending(false);
    }
  }

  const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, marginBottom: 4, fontSize: 13 };
  const inputStyle: React.CSSProperties = { width: "100%", padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 4, fontSize: 14, boxSizing: "border-box" };
  const fieldStyle: React.CSSProperties = { marginBottom: 14 };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Email Sample Sender</h1>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>
        Renders any pre-cruise or group email template and optionally sends it via Resend. Uses AI Travel Concierge branding. Rate-limited to 50 sends/day.
      </p>

      <form onSubmit={(e) => void handleSend(e)}>
        <div style={fieldStyle}>
          <label style={labelStyle}>Template</label>
          <select value={template} onChange={(e) => setTemplate(e.target.value)} style={inputStyle}>
            {TEMPLATE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Destination Email (required for Send)</label>
          <input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} style={inputStyle} placeholder="you@example.com" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
          <div>
            <label style={labelStyle}>Customer Name</label>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Ship Name</label>
            <input value={shipName} onChange={(e) => setShipName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Cruise Line</label>
            <input value={cruiseLine} onChange={(e) => setCruiseLine(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Sailing Date</label>
            <input type="date" value={sailingDate} onChange={(e) => setSailingDate(e.target.value)} style={inputStyle} />
          </div>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Destination Region (hero image)</label>
          <select value={region} onChange={(e) => setRegion(e.target.value)} style={inputStyle}>
            {REGION_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Ports of Call (one per line)</label>
          <textarea value={ports} onChange={(e) => setPorts(e.target.value)} rows={7} style={{ ...inputStyle, resize: "vertical" }} />
        </div>

        <div style={fieldStyle}>
          <label style={labelStyle}>Companion Page URL</label>
          <input value={companionUrl} onChange={(e) => setCompanionUrl(e.target.value)} style={inputStyle} />
        </div>

        {isGroup && (
          <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6, padding: "12px 14px", marginBottom: 14 }}>
            <p style={{ fontWeight: 600, fontSize: 13, marginTop: 0, marginBottom: 12 }}>Group Template Fields</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>Group Name</label>
                <input value={groupName} onChange={(e) => setGroupName(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Invitee Name</label>
                <input value={inviteeName} onChange={(e) => setInviteeName(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Invite URL</label>
                <input value={inviteUrl} onChange={(e) => setInviteUrl(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Broadcast Subject</label>
                <input value={broadcastSubject} onChange={(e) => setBroadcastSubject(e.target.value)} style={inputStyle} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Coordinator Message</label>
              <textarea value={coordinatorMsg} onChange={(e) => setCoordinatorMsg(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={labelStyle}>Broadcast Message</label>
              <textarea value={broadcastMessage} onChange={(e) => setBroadcastMessage(e.target.value)} rows={4} style={{ ...inputStyle, resize: "vertical" }} />
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button type="button" onClick={handlePreview} style={{ padding: "8px 18px", background: "#f3f4f6", border: "1px solid #d1d5db", borderRadius: 5, cursor: "pointer", fontSize: 14, fontWeight: 500 }}>
            Preview in new tab
          </button>
          <button type="submit" disabled={sending || !toEmail} style={{ padding: "8px 18px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 5, cursor: sending || !toEmail ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 600, opacity: sending || !toEmail ? 0.6 : 1 }}>
            {sending ? "Sending…" : "Send via Resend"}
          </button>
        </div>

        {result && <p style={{ marginTop: 12, color: "#16a34a", fontWeight: 500 }}>{result}</p>}
        {error && <p style={{ marginTop: 12, color: "#dc2626" }}>{error}</p>}
      </form>
    </div>
  );
}
