"use client";

// §33.12 — Platform-admin authority-override curation UI.
//
// Lists knowledge_chunks with filters (source / scope / has_override).
// Each row shows the current effective authority + the auto/override
// breakdown. Inline form lets admin set or clear authority_manual_override
// with a required reason.

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

interface ChunkRow {
  id: string;
  content: string;
  source_url: string | null;
  source_type: string | null;
  scope: string | null;
  tenant_id: string | null;
  category: string | null;
  authority_auto: number | null;
  authority_manual_override: number | null;
  authority_override_reason: string | null;
  authority_override_set_at: string | null;
  ingested_at: string;
}

interface ListResponse {
  items: ChunkRow[];
  page: number;
  page_size: number;
  total: number;
}

const SOURCE_OPTIONS = [
  { value: "", label: "Any source" },
  { value: "cruisemapper", label: "CruiseMapper (ingest)" },
  { value: "cruisemapper_itinerary", label: "CruiseMapper itinerary" },
  { value: "tenant_submission", label: "Tenant submission" },
];

const SCOPE_OPTIONS = [
  { value: "", label: "Any scope" },
  { value: "global", label: "Global" },
  { value: "tenant", label: "Tenant" },
];

const OVERRIDE_OPTIONS = [
  { value: "", label: "Any" },
  { value: "true", label: "With override" },
  { value: "false", label: "Without override" },
];

export default function AuthorityCurationPage(): JSX.Element {
  const [items, setItems] = useState<ChunkRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [hasOverrideFilter, setHasOverrideFilter] = useState("");
  const [editingChunkId, setEditingChunkId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/rag/authority/list", window.location.origin);
      url.searchParams.set("page", String(page));
      if (sourceFilter) url.searchParams.set("source", sourceFilter);
      if (scopeFilter) url.searchParams.set("scope", scopeFilter);
      if (hasOverrideFilter) url.searchParams.set("has_override", hasOverrideFilter);

      const res = await adminFetch(url.toString());
      if (!res.ok) throw new Error(`load_failed_${res.status}`);
      const data = (await res.json()) as ListResponse;
      setItems(data.items);
      setTotal(data.total);
      setPageSize(data.page_size);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sourceFilter, scopeFilter, hasOverrideFilter]);

  function startEdit(chunk: ChunkRow): void {
    setEditingChunkId(chunk.id);
    setEditValue(
      chunk.authority_manual_override !== null
        ? String(chunk.authority_manual_override)
        : "",
    );
    setEditReason(chunk.authority_override_reason ?? "");
  }

  function cancelEdit(): void {
    setEditingChunkId(null);
    setEditValue("");
    setEditReason("");
  }

  async function saveEdit(chunk: ChunkRow): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const overrideNum =
        editValue.trim() === "" ? null : Number(editValue.trim());
      if (overrideNum !== null) {
        if (!Number.isFinite(overrideNum) || overrideNum < 0 || overrideNum > 1) {
          setError("Override must be a number between 0 and 1, or empty to clear.");
          setSaving(false);
          return;
        }
        if (!editReason.trim()) {
          setError("Reason is required when setting an override.");
          setSaving(false);
          return;
        }
      }
      const res = await adminFetch(`/api/admin/rag/authority/${chunk.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authority_manual_override: overrideNum,
          reason: editReason.trim(),
          origin_tenant_id: chunk.tenant_id,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `save_failed_${res.status}`);
        return;
      }
      cancelEdit();
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride(chunk: ChunkRow): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/rag/authority/${chunk.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authority_manual_override: null,
          reason: "",
          origin_tenant_id: chunk.tenant_id,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? `clear_failed_${res.status}`);
        return;
      }
      await load();
    } finally {
      setSaving(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main style={{ padding: "2rem", fontFamily: "sans-serif", maxWidth: "1200px" }}>
      <h1>RAG Authority Override</h1>
      <p style={{ color: "#6b7280", fontSize: 14 }}>
        Curate authority scores on imported knowledge chunks. Setting an
        override changes the chunk&apos;s effective authority during
        retrieval ranking (per §6.10 / §33.12). The auto-computed
        authority is preserved.
      </p>

      {error && (
        <div
          style={{
            margin: "1rem 0",
            padding: "0.75rem 1rem",
            background: "#fee2e2",
            border: "1px solid #dc2626",
            borderRadius: 6,
            color: "#991b1b",
          }}
        >
          {error}
        </div>
      )}

      {/* Filters */}
      <section style={{ margin: "1rem 0", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
        <label>
          <span style={{ display: "block", fontSize: 12, color: "#374151" }}>Source</span>
          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span style={{ display: "block", fontSize: 12, color: "#374151" }}>Scope</span>
          <select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span style={{ display: "block", fontSize: 12, color: "#374151" }}>Override</span>
          <select value={hasOverrideFilter} onChange={(e) => setHasOverrideFilter(e.target.value)}>
            {OVERRIDE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <div style={{ marginLeft: "auto", alignSelf: "flex-end", color: "#6b7280", fontSize: 13 }}>
          {total} chunks · page {page} of {pages}
        </div>
      </section>

      {/* List */}
      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No chunks match these filters.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
              <th style={{ padding: "0.5rem" }}>Content (excerpt)</th>
              <th style={{ padding: "0.5rem" }}>Source</th>
              <th style={{ padding: "0.5rem" }}>Scope</th>
              <th style={{ padding: "0.5rem" }}>Auto</th>
              <th style={{ padding: "0.5rem" }}>Override</th>
              <th style={{ padding: "0.5rem" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((chunk) => {
              const isEditing = editingChunkId === chunk.id;
              const effective =
                chunk.authority_manual_override ?? chunk.authority_auto ?? 0;
              return (
                <tr key={chunk.id} style={{ borderBottom: "1px solid #f3f4f6", verticalAlign: "top" }}>
                  <td style={{ padding: "0.5rem", maxWidth: 320 }}>
                    <div style={{ color: "#111827" }}>
                      {chunk.content?.slice(0, 200)}
                      {chunk.content && chunk.content.length > 200 ? "…" : ""}
                    </div>
                    {chunk.source_url && (
                      <a
                        href={chunk.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ display: "block", fontSize: 11, color: "#2563eb", marginTop: 4 }}
                      >
                        {chunk.source_url}
                      </a>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem", fontSize: 12 }}>
                    {chunk.source_type ?? "—"}
                    {chunk.category && (
                      <div style={{ color: "#6b7280" }}>{chunk.category}</div>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem" }}>{chunk.scope ?? "—"}</td>
                  <td style={{ padding: "0.5rem", fontFamily: "monospace" }}>
                    {chunk.authority_auto?.toFixed(2) ?? "—"}
                  </td>
                  <td style={{ padding: "0.5rem", fontFamily: "monospace" }}>
                    {isEditing ? (
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        placeholder="0.00-1.00 or blank to clear"
                        style={{ width: 140 }}
                      />
                    ) : chunk.authority_manual_override !== null ? (
                      <>
                        <div>
                          <strong>{chunk.authority_manual_override.toFixed(2)}</strong>
                        </div>
                        {chunk.authority_override_reason && (
                          <div style={{ fontSize: 11, color: "#6b7280", maxWidth: 180 }}>
                            {chunk.authority_override_reason}
                          </div>
                        )}
                        {chunk.authority_override_set_at && (
                          <div style={{ fontSize: 10, color: "#9ca3af" }}>
                            {new Date(chunk.authority_override_set_at).toLocaleString()}
                          </div>
                        )}
                      </>
                    ) : (
                      <span style={{ color: "#9ca3af" }}>—</span>
                    )}
                    {isEditing && (
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEditReason(e.target.value)}
                        placeholder="Reason (required to set)"
                        maxLength={500}
                        style={{ display: "block", width: 220, marginTop: 4 }}
                      />
                    )}
                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                      effective: {effective.toFixed(2)}
                    </div>
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void saveEdit(chunk)}
                          style={{ marginRight: 4 }}
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button type="button" onClick={cancelEdit} disabled={saving}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => startEdit(chunk)} style={{ marginRight: 4 }}>
                          Edit
                        </button>
                        {chunk.authority_manual_override !== null && (
                          <button
                            type="button"
                            onClick={() => void clearOverride(chunk)}
                            disabled={saving}
                          >
                            Clear
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", justifyContent: "center" }}>
          <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            Previous
          </button>
          <span style={{ alignSelf: "center", color: "#6b7280" }}>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={page === pages}
          >
            Next
          </button>
        </div>
      )}
    </main>
  );
}
