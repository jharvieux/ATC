"use client";

// BP40 §33.8 — subscriber-facing price-watch dashboard.
//
// Lists the caller's watches with per-row actions (pause/resume/cancel/rearm)
// and a "New watch" affordance. The "Set price watch" modal on the booking
// detail page is a separate concern that lands when that page exists.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

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

function statusBadgeClass(s: WatchStatus): string {
  switch (s) {
    case "active":    return "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300";
    case "triggered": return "bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300";
    case "paused":    return "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300";
    case "expired":   return "bg-gray-50 dark:bg-gray-800 text-muted-foreground";
    case "cancelled": return "bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300";
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
    <main className="max-w-[920px] mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold m-0">Price watches</h1>
        <p className="text-muted-foreground mt-1">
          We&apos;ll alert you when a sailing&apos;s price drops below the threshold you set.
        </p>
      </header>

      {error && (
        <div role="alert" className="bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 p-3 rounded-md mb-4">
          {error}
        </div>
      )}

      {watches === null && <p>Loading…</p>}

      {watches !== null && watches.length === 0 && (
        <div className="p-6 bg-muted rounded-lg text-muted-foreground">
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
              <section key={status} aria-labelledby={`section-${status}`} className="mb-6">
                <h2 id={`section-${status}`} className="text-[14px] font-semibold text-foreground uppercase tracking-[0.5px] mb-2">
                  {status} ({rows.length})
                </h2>
                <ul className="list-none p-0 m-0 grid gap-2">
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
  return (
    <li
      data-testid="price-watch-row"
      data-watch-id={w.watch_id}
      data-status={w.status}
      className="p-3.5 bg-card border border-border rounded-lg grid grid-cols-[1fr_auto] gap-3"
    >
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <strong>{w.ship}</strong>
          <span className="text-muted-foreground">· {w.cruise_line}</span>
          <span className="text-muted-foreground">· {w.sail_date}</span>
          <span
            data-testid="status-badge"
            className={`text-[11px] px-2 py-0.5 rounded-full uppercase tracking-[0.3px] font-semibold ${statusBadgeClass(w.status)}`}
          >
            {w.status}
          </span>
        </div>
        <div className="mt-1 text-muted-foreground text-[14px]">
          {w.departure_port} · {w.cabin_class} · baseline {w.baseline_currency} {Number(w.baseline_price).toFixed(0)} · {formatThreshold(w)}
        </div>
      </div>
      <div className="flex gap-1.5 items-center">
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
    <Button
      type="button"
      variant={variant === "danger" ? "outline" : "default"}
      onClick={() => void onClick()}
      disabled={disabled}
      className={`h-8 text-[13px] px-2.5 ${variant === "danger" ? "text-red-700 dark:text-red-400 border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-950/30" : ""}`}
    >
      {label}
    </Button>
  );
}
