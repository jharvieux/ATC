"use client";

// §24.5 / §26.11 — Platform deny-list management UI (platform_super_admin).
//
// Add / remove terms. Existing terms are shown by HASH ONLY (the term itself
// is never returned by the API — protects the deny-list from being reverse-
// engineered). Quarterly review reminder is the §24.5 Inngest cron.

import { useEffect, useState } from "react";

interface DenylistData {
  count: number;
  hashes: string[];
}

export default function AdminDenylistPage(): JSX.Element {
  const [data, setData] = useState<DenylistData>({ count: 0, hashes: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newTerm, setNewTerm] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/admin/denylist", {
        headers: { "x-admin-user-id": "admin" },
      });
      if (!res.ok) throw new Error(`load failed: ${res.status}`);
      const body = (await res.json()) as DenylistData;
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addTerm(): Promise<void> {
    if (!newTerm.trim() || !reason.trim()) {
      setError("Term and reason are both required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/denylist", {
        method: "POST",
        headers: { "x-admin-user-id": "admin", "content-type": "application/json" },
        body: JSON.stringify({ term: newTerm.trim(), reason: reason.trim() }),
      });
      const body = (await res.json()) as { added?: boolean; count?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "add failed");
      setMsg(body.added ? "Term added." : "Term already in list — no change.");
      setNewTerm("");
      setReason("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeHash(hash: string): Promise<void> {
    if (!confirm("Remove this term from the deny-list?")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/denylist?hash=${encodeURIComponent(hash)}`, {
        method: "DELETE",
        headers: { "x-admin-user-id": "admin" },
      });
      const body = (await res.json()) as { removed?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? "remove failed");
      setMsg(body.removed ? "Term removed." : "Hash not found.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv(): void {
    const csv = ["term_hash", ...data.hashes].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `denylist-hashes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
      <h1>Platform deny-list</h1>
      <p style={{ color: "#555" }}>
        Slurs and hate-speech terms blocked on every AI response.{" "}
        <strong>{data.count}</strong> term{data.count === 1 ? "" : "s"} currently in the list.
        Terms themselves are not retrievable — only hashes are shown.
      </p>

      {error && (
        <div style={{ background: "#fee2e2", padding: 12, marginTop: 16, borderRadius: 6 }}>
          {error}
        </div>
      )}
      {msg && (
        <div style={{ background: "#dcfce7", padding: 12, marginTop: 16, borderRadius: 6 }}>
          {msg}
        </div>
      )}

      <section style={{ marginTop: 24, padding: 16, border: "1px solid #e5e7eb", borderRadius: 8 }}>
        <h2 style={{ marginTop: 0 }}>Add term</h2>
        <label style={{ display: "block", marginBottom: 8 }}>
          Term
          <input
            type="text"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
            disabled={busy}
          />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          Reason (recorded in audit log)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ display: "block", width: "100%", padding: 6, marginTop: 4 }}
            disabled={busy}
          />
        </label>
        <button type="button" onClick={addTerm} disabled={busy || loading}>
          {busy ? "Saving…" : "Add term"}
        </button>
      </section>

      <section style={{ marginTop: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Hashes</h2>
          <button type="button" onClick={downloadCsv} disabled={data.hashes.length === 0}>
            Download CSV
          </button>
        </div>
        {loading ? (
          <p>Loading…</p>
        ) : data.hashes.length === 0 ? (
          <p style={{ color: "#777" }}>List is empty.</p>
        ) : (
          <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", padding: 8 }}>
                  Hash
                </th>
                <th style={{ borderBottom: "1px solid #e5e7eb", padding: 8 }}></th>
              </tr>
            </thead>
            <tbody>
              {data.hashes.map((h) => (
                <tr key={h}>
                  <td style={{ padding: 8, fontFamily: "monospace" }}>{h}</td>
                  <td style={{ padding: 8, textAlign: "right" }}>
                    <button type="button" onClick={() => removeHash(h)} disabled={busy}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
