"use client";

// §25.4a Category 3 — Tenant admin review of notes whose customer FK was
// anonymized by a CCPA purge. Text was preserved; this page lets the admin
// redact any residual PII inline.

import { useEffect, useState } from "react";

interface NoteRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  notes: string | null;
  anonymized_customer_hash: string | null;
  updated_at: string;
}

export default function AnonymizedNotesPage(): JSX.Element {
  const [rows, setRows] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      // The contacts table is tenant-scoped via RLS, so the unfiltered list
      // gives us this tenant's rows. We filter to anonymized rows server-side
      // through a query param so we don't pull every contact.
      const res = await fetch("/api/tenant/crm/notes/list?anonymized=true");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `load failed: ${res.status}`);
      }
      const body = (await res.json()) as { rows: NoteRow[] };
      setRows(body.rows);
      const e: Record<string, string> = {};
      for (const r of body.rows) e[r.id] = r.notes ?? "";
      setEdits(e);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function save(id: string): Promise<void> {
    setSavingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/crm/notes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: edits[id] ?? "" }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "save failed");
      setSavedId(id);
      setTimeout(() => setSavedId((curr) => (curr === id ? null : curr)), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <main style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
      <h1>Anonymized CRM notes</h1>
      <p style={{ color: "#555" }}>
        These notes were preserved through a customer&rsquo;s CCPA deletion (the
        text is your business record). The customer identifier has been
        anonymized to a hash placeholder. Review each note and redact any
        personally identifying information that may remain in the body.
      </p>
      {error && <div style={{ background: "#fee2e2", padding: 12, borderRadius: 6 }}>{error}</div>}

      {loading ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: "#777" }}>No anonymized notes to review.</p>
      ) : (
        rows.map((r) => (
          <section
            key={r.id}
            style={{
              padding: 16,
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              marginTop: 12,
              background: "#fff",
            }}
          >
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
              Hash: <code>{r.anonymized_customer_hash}</code> · last updated{" "}
              {new Date(r.updated_at).toLocaleString()}
            </div>
            <textarea
              value={edits[r.id] ?? ""}
              onChange={(e) => setEdits((curr) => ({ ...curr, [r.id]: e.target.value }))}
              rows={4}
              style={{ width: "100%", padding: 8, fontFamily: "inherit" }}
              disabled={savingId === r.id}
            />
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button type="button" onClick={() => save(r.id)} disabled={savingId === r.id}>
                {savingId === r.id ? "Saving…" : "Save"}
              </button>
              {savedId === r.id && <span style={{ color: "#16a34a", fontSize: 13 }}>Saved.</span>}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
