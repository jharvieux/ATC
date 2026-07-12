"use client";

// #489 — Platform admin email sample sender.
// Renders any pre-cruise or group template to HTML and optionally sends it
// via Resend so admins can verify design and deliverability.
//
// #1791 — form fields consolidated into one useReducer (was 15 separate
// useState calls, one per field); request state (sending/result/error)
// stays as plain useState since it's a different concern.

import { useReducer, useState } from "react";
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

interface FormState {
  template: string;
  toEmail: string;
  customerName: string;
  shipName: string;
  cruiseLine: string;
  sailingDate: string;
  region: string;
  ports: string;
  companionUrl: string;
  groupName: string;
  inviteeName: string;
  coordinatorMsg: string;
  inviteUrl: string;
  broadcastSubject: string;
  broadcastMessage: string;
}

const initialFormState: FormState = {
  template: "T90",
  toEmail: "",
  customerName: "Jordan",
  shipName: "Norwegian Bliss",
  cruiseLine: "Norwegian Cruise Line",
  sailingDate: DEFAULT_SAILING_DATE,
  region: "caribbean",
  ports: DEFAULT_PORTS,
  companionUrl: "https://example.com/companion",
  groupName: "Our Group Cruise",
  inviteeName: "Alex",
  coordinatorMsg: "We're so excited you can join us!",
  inviteUrl: "https://example.com/group/invite/token",
  broadcastSubject: "Update from your group coordinator",
  broadcastMessage: "Hello everyone! Just a quick update from your coordinator.\n\nLooking forward to seeing you on board!",
};

function formReducer(state: FormState, action: { field: keyof FormState; value: string }): FormState {
  return { ...state, [action.field]: action.value };
}

export default function EmailSamplesPage() {
  const [form, dispatch] = useReducer(formReducer, initialFormState);
  const setField = (field: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      dispatch({ field, value: e.target.value });

  const [sending, setSending] = useState(false);
  const [result, setResult]   = useState<string | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const isGroup = form.template === "GroupInvitation" || form.template === "GroupBroadcast";

  function buildParams(): Record<string, string> {
    const base: Record<string, string> = {
      template: form.template,
      customer_name: form.customerName,
      ship_name: form.shipName,
      cruise_line: form.cruiseLine,
      sailing_date: new Date(form.sailingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      ports: form.ports,
      destination_region: form.region,
      companion_page_url: form.companionUrl,
    };
    if (isGroup) {
      base.group_name         = form.groupName;
      base.invitee_name       = form.inviteeName;
      base.coordinator_message = form.coordinatorMsg;
      base.invite_url         = form.inviteUrl;
      base.broadcast_subject  = form.broadcastSubject;
      base.broadcast_message  = form.broadcastMessage;
    }
    return base;
  }

  function handlePreview() {
    const params = new URLSearchParams(buildParams());
    window.open(`/api/admin/email-samples?${params.toString()}`, "_blank");
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!form.toEmail) return;
    setSending(true);
    setResult(null);
    setError(null);
    try {
      const res = await adminFetch("/api/admin/email-samples", {
        method: "POST",
        body: JSON.stringify({ ...buildParams(), to_email: form.toEmail }),
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

      {/* allow-void-async: React onSubmit requires a void handler; errors are surfaced in component state */}
      <form onSubmit={(e) => void handleSend(e)}>
        <div className="mb-3.5">
          <label className={labelCls}>Template</label>
          <select value={form.template} onChange={setField("template")} className={inputCls}>
            {TEMPLATE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Destination Email (required for Send)</label>
          <input type="email" value={form.toEmail} onChange={setField("toEmail")} className={inputCls} placeholder="you@example.com" />
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3.5">
          <div>
            <label className={labelCls}>Customer Name</label>
            <input value={form.customerName} onChange={setField("customerName")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Ship Name</label>
            <input value={form.shipName} onChange={setField("shipName")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Cruise Line</label>
            <input value={form.cruiseLine} onChange={setField("cruiseLine")} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Sailing Date</label>
            <input type="date" value={form.sailingDate} onChange={setField("sailingDate")} className={inputCls} />
          </div>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Destination Region (hero image)</label>
          <select value={form.region} onChange={setField("region")} className={inputCls}>
            {REGION_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Ports of Call (one per line)</label>
          <textarea value={form.ports} onChange={setField("ports")} rows={7} className={`${inputCls} resize-y`} />
        </div>

        <div className="mb-3.5">
          <label className={labelCls}>Companion Page URL</label>
          <input value={form.companionUrl} onChange={setField("companionUrl")} className={inputCls} />
        </div>

        {isGroup && (
          <div className="bg-muted border border-border rounded-md px-3.5 py-3 mb-3.5">
            <p className="font-semibold text-[13px] mt-0 mb-3">Group Template Fields</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Group Name</label>
                <input value={form.groupName} onChange={setField("groupName")} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Invitee Name</label>
                <input value={form.inviteeName} onChange={setField("inviteeName")} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Invite URL</label>
                <input value={form.inviteUrl} onChange={setField("inviteUrl")} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Broadcast Subject</label>
                <input value={form.broadcastSubject} onChange={setField("broadcastSubject")} className={inputCls} />
              </div>
            </div>
            <div className="mt-3">
              <label className={labelCls}>Coordinator Message</label>
              <textarea value={form.coordinatorMsg} onChange={setField("coordinatorMsg")} rows={3} className={`${inputCls} resize-y`} />
            </div>
            <div className="mt-3">
              <label className={labelCls}>Broadcast Message</label>
              <textarea value={form.broadcastMessage} onChange={setField("broadcastMessage")} rows={4} className={`${inputCls} resize-y`} />
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
            disabled={sending || !form.toEmail}
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
