"use client";

// §24.5 — Tenant supplemental hate-speech deny-list (Pro+ only).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function TenantSafetyPage(): JSX.Element {
  const [terms, setTerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTerm, setNewTerm] = useState("");

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/tenant/safety");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `load failed: ${res.status}`);
      }
      const body = (await res.json()) as { terms: string[] };
      setTerms(body.terms);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function add(): Promise<void> {
    const term = newTerm.trim();
    if (!term) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/safety", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ term }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "add failed");
      setNewTerm("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(term: string): Promise<void> {
    if (!confirm(`Remove "${term}" from the supplemental list?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tenant/safety?term=${encodeURIComponent(term)}`, {
        method: "DELETE",
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "remove failed");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="px-6 py-8 max-w-[720px] mx-auto">
      <h1>Safety — supplemental deny-list</h1>
      <p className="text-muted-foreground">
        Add terms to your tenant&rsquo;s supplemental list. These are blocked in
        addition to the platform&rsquo;s list — you can&rsquo;t remove terms
        the platform has blocked. Pro+ tier only.
      </p>
      {error && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-3.5 py-2.5 rounded-md mt-4">
          {error}
        </div>
      )}

      <section className="mt-6">
        <h2>Add term</h2>
        <div className="flex gap-2 mt-2">
          <Input
            type="text"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            disabled={busy}
            className="max-w-[360px]"
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
          />
          <Button type="button" onClick={add} disabled={busy || loading}>
            Add
          </Button>
        </div>
      </section>

      <section className="mt-6">
        <h2>Your list ({terms.length})</h2>
        {loading ? (
          <p>Loading…</p>
        ) : terms.length === 0 ? (
          <p className="text-muted-foreground">Empty.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {terms.map((t) => (
              <li key={t} className="flex items-center gap-3">
                <code className="font-mono text-sm">{t}</code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => remove(t)}
                  disabled={busy}
                  className="h-7 text-[13px] px-2.5"
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
