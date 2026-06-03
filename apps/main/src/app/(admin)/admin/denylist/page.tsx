"use client";

// §24.5 / §26.11 — Platform deny-list management UI (platform_super_admin).
//
// Add / remove terms. Existing terms are shown by HASH ONLY (the term itself
// is never returned by the API — protects the deny-list from being reverse-
// engineered). Quarterly review reminder is the §24.5 Inngest cron.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

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
      const res = await adminFetch("/api/admin/denylist");
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
      const res = await adminFetch("/api/admin/denylist", {
        method: "POST",
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
      const res = await adminFetch(`/api/admin/denylist?hash=${encodeURIComponent(hash)}`, {
        method: "DELETE",
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
    <main className="px-6 py-6 max-w-[760px] mx-auto">
      <h1>Platform deny-list</h1>
      <p className="text-muted-foreground">
        Slurs and hate-speech terms blocked on every AI response.{" "}
        <strong>{data.count}</strong> term{data.count === 1 ? "" : "s"} currently in the list.
        Terms themselves are not retrievable — only hashes are shown.
      </p>

      {error && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-3.5 py-2.5 rounded-md mt-4">
          {error}
        </div>
      )}
      {msg && (
        <div className="bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-800 dark:text-green-300 px-3.5 py-2.5 rounded-md mt-4">
          {msg}
        </div>
      )}

      <section className="mt-6 p-4 border border-border rounded-lg">
        <h2 className="mt-0">Add term</h2>
        <label className="block mb-2">
          Term
          <input
            type="text"
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            className="block w-full px-2 py-1.5 border border-border rounded mt-1 text-sm"
            disabled={busy}
          />
        </label>
        <label className="block mb-2">
          Reason (recorded in audit log)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="block w-full px-2 py-1.5 border border-border rounded mt-1 text-sm"
            disabled={busy}
          />
        </label>
        <button
          type="button"
          onClick={addTerm}
          disabled={busy || loading}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-semibold disabled:opacity-50"
        >
          {busy ? "Saving…" : "Add term"}
        </button>
      </section>

      <section className="mt-6">
        <div className="flex justify-between items-center">
          <h2 className="m-0">Hashes</h2>
          <button
            type="button"
            onClick={downloadCsv}
            disabled={data.hashes.length === 0}
            className="px-3 py-1.5 border border-border rounded text-sm disabled:opacity-50"
          >
            Download CSV
          </button>
        </div>
        {loading ? (
          <p>Loading…</p>
        ) : data.hashes.length === 0 ? (
          <p className="text-muted-foreground">List is empty.</p>
        ) : (
          <table className="w-full mt-3 border-collapse text-sm">
            <thead>
              <tr>
                <th className="text-left border-b border-border px-2 py-2">
                  Hash
                </th>
                <th className="border-b border-border px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.hashes.map((h) => (
                <tr key={h}>
                  <td className="px-2 py-2 font-mono">{h}</td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeHash(h)}
                      disabled={busy}
                      className="px-3 py-1 border border-border rounded text-sm disabled:opacity-50"
                    >
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
