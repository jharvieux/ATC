"use client";

// §24.5 — Tenant supplemental hate-speech deny-list (Pro+ only).

import { useEffect, useState } from "react";

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
    <main style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>Safety — supplemental deny-list</h1>
      <p style={{ color: "#555" }}>
        Add terms to your tenant&rsquo;s supplemental list. These are blocked in
        addition to the platform&rsquo;s list — you can&rsquo;t remove terms
        the platform has blocked. Pro+ tier only.
      </p>
      {error && (
        <div style={{ background: "#fee2e2", padding: 12, marginTop: 16, borderRadius: 6 }}>
          {error}
        </div>
      )}

      <section style={{ marginTop: 24 }}>
        <h2>Add term</h2>
        <input
          type="text"
          value={newTerm}
          onChange={(e) => setNewTerm(e.target.value)}
          disabled={busy}
          style={{ padding: 6, width: "60%" }}
        />{" "}
        <button type="button" onClick={add} disabled={busy || loading}>
          Add
        </button>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Your list ({terms.length})</h2>
        {loading ? (
          <p>Loading…</p>
        ) : terms.length === 0 ? (
          <p style={{ color: "#777" }}>Empty.</p>
        ) : (
          <ul>
            {terms.map((t) => (
              <li key={t} style={{ marginBottom: 6 }}>
                <span style={{ fontFamily: "monospace" }}>{t}</span>{" "}
                <button type="button" onClick={() => remove(t)} disabled={busy}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
