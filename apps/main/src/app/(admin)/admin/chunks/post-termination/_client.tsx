"use client";

// §15.14.4 — Post-termination chunk review queue.
// Lists globally-promoted chunks from terminated tenants awaiting admin review.
// Three actions: retain, demote (tenant-scoped → purged after 90d), hard-delete.

import { useState, useEffect, useCallback } from "react";
import { formatDate } from "@/lib/format-date";
import { adminFetch } from "@/lib/admin-fetch";

interface Chunk {
  id: string;
  content: string;
  source_url: string | null;
  source_type: string | null;
  tenant_id: string | null;
  terminated_origin_tenant_id: string | null;
  post_termination_review_status: string;
  created_at: string;
}

export default function PostTerminationReviewPage() {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadChunks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/chunks/post-termination?page=${page}`);
      if (!res.ok) throw new Error("Failed to load chunks.");
      const data = await res.json() as { chunks: Chunk[]; total: number };
      setChunks(data.chunks ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { loadChunks(); }, [loadChunks]);

  async function takeAction(chunkId: string, action: "retain" | "demote" | "hard_delete") {
    setActing(chunkId);
    setError(null);
    try {
      const res = await adminFetch("/api/admin/chunks/post-termination", {
        method: "POST",
        body: JSON.stringify({ chunk_id: chunkId, action }),
      });
      if (!res.ok) {
        const data = await res.json() as { error: string };
        throw new Error(data.error ?? "Action failed.");
      }
      // Remove the actioned chunk from the list.
      setChunks((prev) => prev.filter((c) => c.id !== chunkId));
      setTotal((prev) => prev - 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Post-Termination Chunk Review</h1>
        <span className="text-sm text-gray-500">
          {total} chunk{total !== 1 ? "s" : ""} pending review
        </span>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : chunks.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No chunks pending review</p>
          <p className="text-sm mt-1">All globally-promoted chunks from terminated tenants have been reviewed.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {chunks.map((chunk) => (
            <div key={chunk.id} className="bg-white border rounded-lg p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    {chunk.source_type && (
                      <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {chunk.source_type}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">
                      Tenant: {chunk.terminated_origin_tenant_id ?? chunk.tenant_id ?? "unknown"}
                    </span>
                    <span className="text-xs text-gray-400">
                      · {formatDate(chunk.created_at)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800 line-clamp-3 mb-1">{chunk.content}</p>
                  {chunk.source_url && (
                    <a
                      href={chunk.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline truncate block max-w-md"
                    >
                      {chunk.source_url}
                    </a>
                  )}
                </div>

                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={acting === chunk.id}
                    onClick={() => takeAction(chunk.id, "retain")}
                    className="px-3 py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    Retain
                  </button>
                  <button
                    type="button"
                    disabled={acting === chunk.id}
                    onClick={() => takeAction(chunk.id, "demote")}
                    className="px-3 py-1.5 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50"
                  >
                    Demote
                  </button>
                  <button
                    type="button"
                    disabled={acting === chunk.id}
                    onClick={() => {
                      if (window.confirm("Permanently delete this chunk from the RAG corpus?")) {
                        takeAction(chunk.id, "hard_delete");
                      }
                    }}
                    className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}

          {/* Pagination */}
          <div className="flex justify-between items-center pt-4">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="text-sm text-blue-600 hover:underline disabled:text-gray-400"
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-500">Page {page}</span>
            <button
              type="button"
              disabled={chunks.length < 20}
              onClick={() => setPage((p) => p + 1)}
              className="text-sm text-blue-600 hover:underline disabled:text-gray-400"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
