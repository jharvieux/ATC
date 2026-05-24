"use client";

// BP40 §33.8 — subscriber-facing price-watch dashboard.
//
// Lists the caller's watches with per-row actions (pause/resume/cancel/rearm)
// and a "New watch" affordance. The "Set price watch" modal on the booking
// detail page is a separate concern that lands when that page exists.

import { useCallback, useEffect, useMemo, useState } from "react";

type WatchStatus = "active" | "triggered" | "paused" | "expired" | "cancelled";

interface PriceWatch {
  watch_id: string;
  cruise_line: string;
  ship: string;
  sail_date: string;
  departure_port: string;
  cabin_class: string;
  baseline_price: string | number;
  baseline_currency: string;
  threshold_kind: "dollar_drop" | "percent_drop" | "either";
  dollar_threshold: string | number | null;
  percent_threshold: string | number | null;
  status: WatchStatus;
  triggered_at: string | null;
  created_at: string;
}

function formatThreshold(w: PriceWatch): string {
  const d = w.dollar_threshold != null ? `$${w.dollar_threshold}` : null;
  const p = w.percent_threshold != null ? `${w.percent_threshold}%` : null;
  if (w.threshold_kind === "dollar_drop") return `drop ≥ ${d}`;
  if (w.threshold_kind === "percent_drop") return `drop ≥ ${p}`;
  return `drop ≥ ${d} OR ${p}`;
}

function statusColor(s: WatchStatus): { bg: string; fg: string } {
  switch (s) {
    case "active":    return { bg: "#dcfce7", fg: "#166534" };
    case "triggered": return { bg: "#fef3c7", fg: "#92400e" };
    case "paused":    return { bg: "#e5e7eb", fg: "#374151" };
    case "expired":   return { bg: "#f3f4f6", fg: "#6b7280" };
    case "cancelled": return { bg: "#fee2e2", fg: "#991b1b" };
  }
}

export default function PriceWatchesPage(): JSX.Element {
  const [watches, setWatches] = useState<PriceWatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/price-watches", { credentials: "include" });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const json = (await res.json()) as { watches: PriceWatch[] };
      setWatches(json.watches);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, body: { status?: "paused" | "active" | "cancelled" }): Promise<void> {
    setBusyId(id);
    try {
      const res = await fetch(`/api/price-watches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`update failed: ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function rearm(id: string): Promise<void> {
    setBusyId(id);
    try {
      const res = await fetch(`/api/price-watches/${id}/rearm`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`rearm failed: ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  const grouped = useMemo(() => {
    if (!watches) return null;
    const buckets: Record<string, PriceWatch[]> = { active: [], triggered: [], paused: [], expired: [], cancelled: [] };
    for (const w of watches) (buckets[w.status] ?? []).push(w);
    return buckets;
  }, [watches]);

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "32px 16px", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Price watches</h1>
        <p style={{ color: "#6b7280", marginTop: 4 }}>
          We&apos;ll alert you when a sailing&apos;s price drops below the threshold you set.
        </p>
      </header>

      {error && (
        <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {watches === null && <p>Loading…</p>}

      {watches !== null && watches.length === 0 && (
        <div style={{ padding: 24, background: "#f9fafb", borderRadius: 8, color: "#6b7280" }}>
          You don&apos;t have any active price watches yet. Set one from a booking&apos;s detail page
          to be notified when prices drop.
        </div>
      )}

      {grouped && watches !== null && watches.length > 0 && (
        <>
          {(["triggered", "active", "paused", "expired", "cancelled"] as WatchStatus[]).map((status) => {
            const rows = grouped[status] ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={status} aria-labelledby={`section-${status}`} style={{ marginBottom: 24 }}>
                <h2 id={`section-${status}`} style={{ fontSize: 14, fontWeight: 600, color: "#374151", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                  {status} ({rows.length})
                </h2>
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                  {rows.map((w) => (
                    <WatchRow key={w.watch_id} w={w} busy={busyId === w.watch_id} onPatch={patch} onRearm={rearm} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </main>
  );
}

function WatchRow({
  w,
  busy,
  onPatch,
  onRearm,
}: {
  w: PriceWatch;
  busy: boolean;
  onPatch: (id: string, body: { status?: "paused" | "active" | "cancelled" }) => Promise<void>;
  onRearm: (id: string) => Promise<void>;
}): JSX.Element {
  const color = statusColor(w.status);
  return (
    <li
      data-testid="price-watch-row"
      data-watch-id={w.watch_id}
      data-status={w.status}
      style={{
        padding: 14,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <strong>{w.ship}</strong>
          <span style={{ color: "#6b7280" }}>· {w.cruise_line}</span>
          <span style={{ color: "#6b7280" }}>· {w.sail_date}</span>
          <span
            data-testid="status-badge"
            style={{
              background: color.bg,
              color: color.fg,
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 10,
              textTransform: "uppercase",
              letterSpacing: 0.3,
              fontWeight: 600,
            }}
          >
            {w.status}
          </span>
        </div>
        <div style={{ marginTop: 4, color: "#4b5563", fontSize: 14 }}>
          {w.departure_port} · {w.cabin_class} · baseline {w.baseline_currency} {Number(w.baseline_price).toFixed(0)} · {formatThreshold(w)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {w.status === "active" && (
          <ActionButton onClick={() => onPatch(w.watch_id, { status: "paused" })} disabled={busy} label="Pause" />
        )}
        {w.status === "paused" && (
          <ActionButton onClick={() => onPatch(w.watch_id, { status: "active" })} disabled={busy} label="Resume" />
        )}
        {w.status === "triggered" && (
          <ActionButton onClick={() => onRearm(w.watch_id)} disabled={busy} label="Re-arm" />
        )}
        {(w.status === "active" || w.status === "paused" || w.status === "triggered") && (
          <ActionButton onClick={() => onPatch(w.watch_id, { status: "cancelled" })} disabled={busy} label="Cancel" variant="danger" />
        )}
      </div>
    </li>
  );
}

function ActionButton({
  onClick, disabled, label, variant,
}: {
  onClick: () => void | Promise<void>;
  disabled: boolean;
  label: string;
  variant?: "danger";
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      style={{
        padding: "6px 10px",
        fontSize: 13,
        background: variant === "danger" ? "#fff" : "#3b82f6",
        color: variant === "danger" ? "#991b1b" : "#fff",
        border: variant === "danger" ? "1px solid #fca5a5" : "none",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}
