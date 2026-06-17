"use client";

// §27.11 — Tenant settings → usage. Shows current-period gauges, RAG
// status, and a "request override" form that POSTs to
// /api/tenant/override-requests.

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type DimRow = {
  dimension: "ai_cost" | "chat_volume" | "email_volume" | "group_invite";
  current: string;
  state: string;
  thresholds: { soft1: string; soft2: string; hard: string };
};
type Rag = {
  state: string;
  current_chunks: number;
  promoted_chunks: number;
  base_cap: number;
  approaching: number;
  effective_cap: number;
};
type Summary = { dims: DimRow[]; rag: Rag; period: string };

type Request_ = {
  id: string;
  dimension: string;
  requested_threshold_kind: string | null;
  current_state: string;
  status: string;
  requested_at: string;
  reviewed_at: string | null;
  deny_reason: string | null;
};

const DIM_LABEL = {
  ai_cost: "AI usage cost",
  chat_volume: "Chat volume",
  email_volume: "Email volume",
  group_invite: "Group invitations",
} as const;

export default function UsagePage(): JSX.Element {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [requests, setRequests] = useState<Request_[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state.
  const [selDim, setSelDim] = useState<DimRow["dimension"] | "rag_cap">("ai_cost");
  const [selKind, setSelKind] = useState<"soft1" | "soft2" | "hard" | "base_cap" | "">("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void Promise.all([
      authFetch("/api/tenant/usage").then((r) => r.json()),
      authFetch("/api/tenant/override-requests").then((r) => r.json()),
    ])
      .then(([u, q]) => {
        if (u.error) setError(u.error);
        else setSummary({ dims: u.dims, rag: u.rag, period: u.period });
        if (!q.error) setRequests(q.items);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function submitRequest() {
    if (reason.length < 5) { alert("Reason must be ≥ 5 characters."); return; }
    setSubmitting(true);
    const currentState =
      selDim === "rag_cap"
        ? summary?.rag.state ?? "ok"
        : summary?.dims.find((d) => d.dimension === selDim)?.state ?? "ok";
    const res = await authFetch("/api/tenant/override-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dimension: selDim,
        requested_threshold_kind: selKind || null,
        current_state: currentState,
        reason,
      }),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!json.ok) alert(json.error ?? "submit failed");
    else { setReason(""); window.location.reload(); }
  }

  if (loading) return <main className="px-6 py-8 max-w-[980px] mx-auto"><p>Loading…</p></main>;
  if (error) return <main className="px-6 py-8 max-w-[980px] mx-auto"><p className="text-red-600 dark:text-red-400">{error}</p></main>;
  if (!summary) return <main className="px-6 py-8 max-w-[980px] mx-auto"><p>No data.</p></main>;

  return (
    <main className="px-6 py-8 max-w-[980px] mx-auto">
      <h1>Usage &amp; limits</h1>
      <p className="text-muted-foreground">Current billing period: {summary.period}</p>

      <h2 className="mt-6">Monthly dimensions</h2>
      <div className="overflow-x-auto mt-2">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Dimension", "Current", "Soft1", "Soft2", "Hard", "State"].map((h) => (
                <th key={h} className="text-left px-2 py-2 border-b border-border bg-muted font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.dims.map((d) => (
              <tr key={d.dimension}>
                <td className="px-2 py-2 border-b border-muted">{DIM_LABEL[d.dimension]}</td>
                <td className="px-2 py-2 border-b border-muted">{d.current}</td>
                <td className="px-2 py-2 border-b border-muted">{d.thresholds.soft1}</td>
                <td className="px-2 py-2 border-b border-muted">{d.thresholds.soft2}</td>
                <td className="px-2 py-2 border-b border-muted">{d.thresholds.hard}</td>
                <td className={`px-2 py-2 border-b border-muted font-semibold ${stateColorClass(d.state)}`}>{d.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-6">RAG knowledge base</h2>
      <p>
        State: <strong className={stateColorClass(summary.rag.state)}>{summary.rag.state}</strong> —
        {" "}{summary.rag.current_chunks} of {summary.rag.effective_cap} chunks used
        {" "}(base cap {summary.rag.base_cap}, promoted +{summary.rag.promoted_chunks}).
      </p>

      <h2 className="mt-6">Request an override</h2>
      <p className="text-muted-foreground mt-0">
        Submitted requests go to platform admins. Approved overrides take effect immediately and last 30 days by default.
      </p>
      <div className="flex gap-2 items-center flex-wrap mt-3">
        <Select value={selDim} onValueChange={(v) => setSelDim(v as DimRow["dimension"] | "rag_cap")}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ai_cost">AI cost</SelectItem>
            <SelectItem value="chat_volume">Chat volume</SelectItem>
            <SelectItem value="email_volume">Email volume</SelectItem>
            <SelectItem value="group_invite">Group invite</SelectItem>
            <SelectItem value="rag_cap">RAG cap</SelectItem>
          </SelectContent>
        </Select>
        <Select value={selKind || "none"} onValueChange={(v) => setSelKind(v === "none" ? "" : v as typeof selKind)}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="— threshold kind (optional) —" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— threshold kind (optional) —</SelectItem>
            <SelectItem value="soft1">soft1</SelectItem>
            <SelectItem value="soft2">soft2</SelectItem>
            <SelectItem value="hard">hard</SelectItem>
            <SelectItem value="base_cap">base_cap (RAG)</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="reason (≥5 chars)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-[360px]"
        />
        <Button type="button" disabled={submitting} onClick={submitRequest}>
          Submit request
        </Button>
      </div>

      <h2 className="mt-8">Your request history</h2>
      <div className="overflow-x-auto mt-2">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {["Dimension", "Kind", "Status", "Requested", "Reviewed", "Deny reason"].map((h) => (
                <th key={h} className="text-left px-2 py-2 border-b border-border bg-muted font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td className="px-2 py-2 border-b border-muted">{r.dimension}</td>
                <td className="px-2 py-2 border-b border-muted">{r.requested_threshold_kind ?? "—"}</td>
                <td className="px-2 py-2 border-b border-muted">{r.status}</td>
                <td className="px-2 py-2 border-b border-muted">{new Date(r.requested_at).toLocaleString()}</td>
                <td className="px-2 py-2 border-b border-muted">{r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : "—"}</td>
                <td className="px-2 py-2 border-b border-muted">{r.deny_reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function stateColorClass(s: string): string {
  if (s === "ok") return "text-green-700 dark:text-green-400";
  if (s === "soft1" || s === "approaching") return "text-amber-700 dark:text-amber-400";
  if (s === "soft2") return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

// §17.x — session is in HttpOnly cookies that ride along same-origin fetches;
// no Bearer to attach. Helper kept so call sites don't churn.
async function authFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
