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

const thCls = "px-2 py-2 text-left border-b-2 border-border font-semibold text-sm";
const tdCls = "px-2 py-2 border-b border-muted align-top text-sm";

interface ListState {
  items: ChunkRow[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: string | null;
}

interface FilterState {
  sourceFilter: string;
  scopeFilter: string;
  hasOverrideFilter: string;
}

interface EditState {
  editingChunkId: string | null;
  editValue: string;
  editReason: string;
  saving: boolean;
}

export default function AuthorityCurationPage(): JSX.Element {
  // #1812 — the 13 useState hooks (list/pagination data, filters, inline
  // edit form) are grouped into 3 state objects by concern, one useState
  // each, matching the pattern established in #1791.
  const [list, setList] = useState<ListState>({
    items: [], total: 0, page: 1, pageSize: 25, loading: true, error: null,
  });
  const [filters, setFilters] = useState<FilterState>({
    sourceFilter: "", scopeFilter: "", hasOverrideFilter: "",
  });
  const [edit, setEdit] = useState<EditState>({
    editingChunkId: null, editValue: "", editReason: "", saving: false,
  });

  async function load(): Promise<void> {
    setList((s) => ({ ...s, loading: true, error: null }));
    try {
      const url = new URL("/api/admin/rag/authority/list", window.location.origin);
      url.searchParams.set("page", String(list.page));
      if (filters.sourceFilter) url.searchParams.set("source", filters.sourceFilter);
      if (filters.scopeFilter) url.searchParams.set("scope", filters.scopeFilter);
      if (filters.hasOverrideFilter) url.searchParams.set("has_override", filters.hasOverrideFilter);

      const res = await adminFetch(url.toString());
      if (!res.ok) throw new Error(`load_failed_${res.status}`);
      const data = (await res.json()) as ListResponse;
      setList((s) => ({ ...s, items: data.items, total: data.total, pageSize: data.page_size }));
    } catch (e) {
      setList((s) => ({ ...s, error: e instanceof Error ? e.message : "load_failed" }));
    } finally {
      setList((s) => ({ ...s, loading: false }));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.page, filters.sourceFilter, filters.scopeFilter, filters.hasOverrideFilter]);

  function startEdit(chunk: ChunkRow): void {
    setEdit({
      editingChunkId: chunk.id,
      editValue: chunk.authority_manual_override !== null ? String(chunk.authority_manual_override) : "",
      editReason: chunk.authority_override_reason ?? "",
      saving: false,
    });
  }

  function cancelEdit(): void {
    setEdit({ editingChunkId: null, editValue: "", editReason: "", saving: false });
  }

  async function saveEdit(chunk: ChunkRow): Promise<void> {
    setEdit((s) => ({ ...s, saving: true }));
    setList((s) => ({ ...s, error: null }));
    try {
      const overrideNum =
        edit.editValue.trim() === "" ? null : Number(edit.editValue.trim());
      if (overrideNum !== null) {
        if (!Number.isFinite(overrideNum) || overrideNum < 0 || overrideNum > 1) {
          setList((s) => ({ ...s, error: "Override must be a number between 0 and 1, or empty to clear." }));
          setEdit((s) => ({ ...s, saving: false }));
          return;
        }
        if (!edit.editReason.trim()) {
          setList((s) => ({ ...s, error: "Reason is required when setting an override." }));
          setEdit((s) => ({ ...s, saving: false }));
          return;
        }
      }
      const res = await adminFetch(`/api/admin/rag/authority/${chunk.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          authority_manual_override: overrideNum,
          reason: edit.editReason.trim(),
          origin_tenant_id: chunk.tenant_id,
        }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setList((s) => ({ ...s, error: data.error ?? `save_failed_${res.status}` }));
        return;
      }
      cancelEdit();
      await load();
    } finally {
      setEdit((s) => ({ ...s, saving: false }));
    }
  }

  async function clearOverride(chunk: ChunkRow): Promise<void> {
    setEdit((s) => ({ ...s, saving: true }));
    setList((s) => ({ ...s, error: null }));
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
        setList((s) => ({ ...s, error: data.error ?? `clear_failed_${res.status}` }));
        return;
      }
      await load();
    } finally {
      setEdit((s) => ({ ...s, saving: false }));
    }
  }

  const { items, total, page, pageSize, loading, error } = list;
  const { sourceFilter, scopeFilter, hasOverrideFilter } = filters;
  const { editingChunkId, editValue, editReason, saving } = edit;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="px-8 py-8 max-w-[1200px]">
      <h1>RAG Authority Override</h1>
      <p className="text-muted-foreground text-[14px]">
        Curate authority scores on imported knowledge chunks. Setting an
        override changes the chunk&apos;s effective authority during
        retrieval ranking (per §6.10 / §33.12). The auto-computed
        authority is preserved.
      </p>

      {error && (
        <div className="my-4 px-4 py-3 bg-red-50 dark:bg-red-950/30 border border-red-600 rounded-md text-red-800 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Filters */}
      <section className="my-4 flex gap-4 flex-wrap items-end">
        <label>
          <span className="block text-[12px] text-foreground mb-0.5">Source</span>
          <select
            value={sourceFilter}
            onChange={(e) => setFilters((f) => ({ ...f, sourceFilter: e.target.value }))}
            className="px-2 py-1.5 border border-border rounded text-sm"
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="block text-[12px] text-foreground mb-0.5">Scope</span>
          <select
            value={scopeFilter}
            onChange={(e) => setFilters((f) => ({ ...f, scopeFilter: e.target.value }))}
            className="px-2 py-1.5 border border-border rounded text-sm"
          >
            {SCOPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="block text-[12px] text-foreground mb-0.5">Override</span>
          <select
            value={hasOverrideFilter}
            onChange={(e) => setFilters((f) => ({ ...f, hasOverrideFilter: e.target.value }))}
            className="px-2 py-1.5 border border-border rounded text-sm"
          >
            {OVERRIDE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <div className="ml-auto text-muted-foreground text-[13px]">
          {total} chunks · page {page} of {pages}
        </div>
      </section>

      {/* List */}
      {loading ? (
        <p>Loading…</p>
      ) : items.length === 0 ? (
        <p>No chunks match these filters.</p>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="text-left">
              <th className={thCls}>Content (excerpt)</th>
              <th className={thCls}>Source</th>
              <th className={thCls}>Scope</th>
              <th className={thCls}>Auto</th>
              <th className={thCls}>Override</th>
              <th className={thCls}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((chunk) => {
              const isEditing = editingChunkId === chunk.id;
              const effective =
                chunk.authority_manual_override ?? chunk.authority_auto ?? 0;
              return (
                <tr key={chunk.id} className="align-top">
                  <td className={`${tdCls} max-w-[320px]`}>
                    <div className="text-foreground">
                      {chunk.content?.slice(0, 200)}
                      {chunk.content && chunk.content.length > 200 ? "…" : ""}
                    </div>
                    {chunk.source_url && (
                      <a
                        href={chunk.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-[11px] text-blue-600 dark:text-blue-400 mt-1"
                      >
                        {chunk.source_url}
                      </a>
                    )}
                  </td>
                  <td className={`${tdCls} text-[12px]`}>
                    {chunk.source_type ?? "—"}
                    {chunk.category && (
                      <div className="text-muted-foreground">{chunk.category}</div>
                    )}
                  </td>
                  <td className={tdCls}>{chunk.scope ?? "—"}</td>
                  <td className={`${tdCls} font-mono`}>
                    {chunk.authority_auto?.toFixed(2) ?? "—"}
                  </td>
                  <td className={`${tdCls} font-mono`}>
                    {isEditing ? (
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={editValue}
                        onChange={(e) => setEdit((s) => ({ ...s, editValue: e.target.value }))}
                        placeholder="0.00-1.00 or blank to clear"
                        className="w-[140px] border border-border rounded px-1.5 py-1 text-[12px]"
                      />
                    ) : chunk.authority_manual_override !== null ? (
                      <>
                        <div>
                          <strong>{chunk.authority_manual_override.toFixed(2)}</strong>
                        </div>
                        {chunk.authority_override_reason && (
                          <div className="text-[11px] text-muted-foreground max-w-[180px]">
                            {chunk.authority_override_reason}
                          </div>
                        )}
                        {chunk.authority_override_set_at && (
                          <div className="text-[10px] text-muted-foreground">
                            {new Date(chunk.authority_override_set_at).toLocaleString()}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {isEditing && (
                      <input
                        type="text"
                        value={editReason}
                        onChange={(e) => setEdit((s) => ({ ...s, editReason: e.target.value }))}
                        placeholder="Reason (required to set)"
                        maxLength={500}
                        className="block w-[220px] mt-1 border border-border rounded px-1.5 py-1 text-[12px]"
                      />
                    )}
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      effective: {effective.toFixed(2)}
                    </div>
                  </td>
                  <td className={tdCls}>
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void saveEdit(chunk)}
                          className="mr-1 px-2 py-1 border border-border rounded text-[12px] disabled:opacity-50"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={saving}
                          className="px-2 py-1 border border-border rounded text-[12px] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(chunk)}
                          className="mr-1 px-2 py-1 border border-border rounded text-[12px]"
                        >
                          Edit
                        </button>
                        {chunk.authority_manual_override !== null && (
                          <button
                            type="button"
                            onClick={() => void clearOverride(chunk)}
                            disabled={saving}
                            className="px-2 py-1 border border-border rounded text-[12px] disabled:opacity-50"
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
        <div className="mt-4 flex gap-2 justify-center">
          <button
            type="button"
            onClick={() => setList((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
            disabled={page === 1}
            className="px-3 py-1.5 border border-border rounded text-sm disabled:opacity-50"
          >
            Previous
          </button>
          <span className="self-center text-muted-foreground">
            Page {page} of {pages}
          </span>
          <button
            type="button"
            onClick={() => setList((s) => ({ ...s, page: Math.min(pages, s.page + 1) }))}
            disabled={page === pages}
            className="px-3 py-1.5 border border-border rounded text-sm disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </main>
  );
}
