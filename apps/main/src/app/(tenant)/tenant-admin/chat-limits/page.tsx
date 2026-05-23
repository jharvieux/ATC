"use client";

// §24.9 — Tenant chat-limit overrides (Pro+ only).

import { useEffect, useState } from "react";

interface LoadShape {
  tier: string;
  can_override: boolean;
  override: {
    soft1_cap?: number;
    soft2_cap?: number;
    hard_cap?: number;
    booking_bonus_percent?: number;
    updated_at?: string;
  } | null;
  defaults: {
    soft1_cap: number;
    soft2_cap: number;
    hard_cap: number;
    booking_bonus_percent: number;
    hard_ceiling: number;
    hard_floor: number;
  };
}

export default function TenantChatLimitsPage(): JSX.Element {
  const [data, setData] = useState<LoadShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [s1, setS1] = useState(20);
  const [s2, setS2] = useState(30);
  const [hd, setHd] = useState(40);
  const [bn, setBn] = useState(100);

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/tenant/chat-limits");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `load failed: ${res.status}`);
      }
      const body = (await res.json()) as LoadShape;
      setData(body);
      const o = body.override ?? {};
      setS1(o.soft1_cap ?? body.defaults.soft1_cap);
      setS2(o.soft2_cap ?? body.defaults.soft2_cap);
      setHd(o.hard_cap ?? body.defaults.hard_cap);
      setBn(o.booking_bonus_percent ?? body.defaults.booking_bonus_percent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/tenant/chat-limits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          soft1_cap: s1,
          soft2_cap: s2,
          hard_cap: hd,
          booking_bonus_percent: bn,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "save failed");
      setMsg("Saved.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <main style={{ padding: 24 }}>Loading…</main>;

  return (
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Customer chat limits</h1>
      <p style={{ color: "#555" }}>
        Three-tier rolling 30-day cap per customer. The booking bonus applies
        when the customer has any future-dated unsailed/uncancelled booking
        with your tenant. Tier: <strong>{data.tier}</strong>.
      </p>
      {!data.can_override && (
        <div style={{ background: "#fef3c7", padding: 12, borderRadius: 6 }}>
          Overrides are Pro+ tier only. You&rsquo;re viewing platform defaults.
        </div>
      )}
      {error && (
        <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6, marginTop: 12 }}>{error}</div>
      )}
      {msg && (
        <div style={{ background: "#dcfce7", padding: 12, borderRadius: 6, marginTop: 12 }}>{msg}</div>
      )}

      <section style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <label>Soft1 cap
          <input type="number" value={s1} onChange={(e) => setS1(Number(e.target.value))}
            disabled={!data.can_override || busy} style={{ display: "block", width: "100%", padding: 6 }} />
        </label>
        <label>Soft2 cap
          <input type="number" value={s2} onChange={(e) => setS2(Number(e.target.value))}
            disabled={!data.can_override || busy} style={{ display: "block", width: "100%", padding: 6 }} />
        </label>
        <label>Hard cap (range {data.defaults.hard_floor}–{data.defaults.hard_ceiling})
          <input type="number" value={hd} onChange={(e) => setHd(Number(e.target.value))}
            disabled={!data.can_override || busy} style={{ display: "block", width: "100%", padding: 6 }} />
        </label>
        <label>Booking bonus % (0–400)
          <input type="number" value={bn} onChange={(e) => setBn(Number(e.target.value))}
            disabled={!data.can_override || busy} style={{ display: "block", width: "100%", padding: 6 }} />
        </label>
      </section>

      <div style={{ marginTop: 24 }}>
        <button type="button" onClick={save} disabled={!data.can_override || busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </main>
  );
}
