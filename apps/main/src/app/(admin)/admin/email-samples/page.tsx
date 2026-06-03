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

const inputCls = "w-full px-2 py-1.5 border border-border rounded text-[14px] box-border";
const labelCls = "block font-semibold mb-1 text-[13px] text-foreground";

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

  // allow-void-async: React onSubmit requires a void handler; errors are surfaced in component state
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

  return (
    <div className="max-w-[720px] mx-auto px-4 py-6">
      <h1 className="text-[20px] font-bold mb-1">Email Sample Sender</h1>
      <p className="text-muted-foreground mb-6 text-[14px]">
        Renders any pre-cruise or group email template and optionally sends it via Resend. Uses AI Travel Concierge branding. Rate-limited to 50 sends/day.
      </p>

      <form onSubmit={(e) => void handleSend(e)}>
        <div className="mb-3.5">
          <label className={labelCls}>Template</label>
          <select value={template} onChange={(e) => setTemplate(e.target.value)} className={inputCls}>
            {TEMPLATE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Destination Email (required for Send)</label>
          <input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} className={inputCls} placeholder="you@example.com" />
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3.5">
          <div>
            <label className={labelCls}>Customer Name</label>
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Ship Name</label>
            <input value={shipName} onChange={(e) => setShipName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Cruise Line</label>
            <input value={cruiseLine} onChange={(e) => setCruiseLine(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Sailing Date</label>
            <input type="date" value={sailingDate} onChange={(e) => setSailingDate(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Destination Region (hero image)</label>
          <select value={region} onChange={(e) => setRegion(e.target.value)} className={inputCls}>
            {REGION_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Ports of Call (one per line)</label>
          <textarea value={ports} onChange={(e) => setPorts(e.target.value)} rows={7} className={`${inputCls} resize-y`} />
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Companion Page URL</label>
          <input value={companionUrl} onChange={(e) => setCompanionUrl(e.target.value)} className={inputCls} />
        </div>

        {isGroup && (
          <div className="bg-muted border border-border rounded-md px-3.5 py-3 mb-3.5">
            <p className="font-semibold text-[13px] mt-0 mb-3">Group Template Fields</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Group Name</label>
                <input value={groupName} onChange={(e) => setGroupName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Invitee Name</label>
                <input value={inviteeName} onChange={(e) => setInviteeName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Invite URL</label>
                <input value={inviteUrl} onChange={(e) => setInviteUrl(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Broadcast Subject</label>
                <input value={broadcastSubject} onChange={(e) => setBroadcastSubject(e.target.value)} className={inputCls} />
              </div>
            </div>
            <div className="mt-3">
              <label className={labelCls}>Coordinator Message</label>
              <textarea value={coordinatorMsg} onChange={(e) => setCoordinatorMsg(e.target.value)} rows={3} className={`${inputCls} resize-y`} />
            </div>
            <div className="mt-3">
              <label className={labelCls}>Broadcast Message</label>
              <textarea value={broadcastMessage} onChange={(e) => setBroadcastMessage(e.target.value)} rows={4} className={`${inputCls} resize-y`} />
            </div>
          </div>
        )}

        <div className="flex gap-2.5 mt-2">
          <button
            type="button"
            onClick={handlePreview}
            className="px-[18px] py-2 bg-muted border border-border rounded-md cursor-pointer text-[14px] font-medium"
          >
            Preview in new tab
          </button>
          <button
            type="submit"
            disabled={sending || !toEmail}
            className="px-[18px] py-2 bg-blue-600 text-white border-none rounded-md text-[14px] font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {sending ? "Sending…" : "Send via Resend"}
          </button>
        </div>

        {result && <p className="mt-3 text-green-700 dark:text-green-400 font-medium">{result}</p>}
        {error && <p className="mt-3 text-red-600 dark:text-red-400">{error}</p>}
      </form>
    </div>
  );
}
