"use client";

// §24.9 — Tenant chat-limit overrides (Pro+ only).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

  if (!data) return <main className="px-6 py-8 max-w-[720px] mx-auto"><p>Loading…</p></main>;

  return (
    <main className="px-6 py-8 max-w-[720px] mx-auto">
      <h1>Customer chat limits</h1>
      <p className="text-muted-foreground">
        Three-tier rolling 30-day cap per customer. The booking bonus applies
        when the customer has any future-dated unsailed/uncancelled booking
        with your tenant. Tier: <strong>{data.tier}</strong>.
      </p>
      {!data.can_override && (
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 text-amber-900 dark:text-amber-200 px-3.5 py-2.5 rounded-md mt-4">
          Overrides are Pro+ tier only. You&rsquo;re viewing platform defaults.
        </div>
      )}
      {error && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-3.5 py-2.5 rounded-md mt-4">{error}</div>
      )}
      {msg && (
        <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300 px-3.5 py-2.5 rounded-md mt-4">{msg}</div>
      )}

      <section className="mt-6 grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s1">Soft1 cap</Label>
          <Input id="s1" type="number" value={s1} onChange={(e) => setS1(Number(e.target.value))}
            disabled={!data.can_override || busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s2">Soft2 cap</Label>
          <Input id="s2" type="number" value={s2} onChange={(e) => setS2(Number(e.target.value))}
            disabled={!data.can_override || busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hd">Hard cap (range {data.defaults.hard_floor}–{data.defaults.hard_ceiling})</Label>
          <Input id="hd" type="number" value={hd} onChange={(e) => setHd(Number(e.target.value))}
            disabled={!data.can_override || busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bn">Booking bonus % (0–400)</Label>
          <Input id="bn" type="number" value={bn} onChange={(e) => setBn(Number(e.target.value))}
            disabled={!data.can_override || busy} />
        </div>
      </section>

      <div className="mt-6">
        <Button type="button" onClick={save} disabled={!data.can_override || busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </main>
  );
}
