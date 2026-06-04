// Issue #686 — reconcileEmbeddingBatches polls OpenAI, applies the output
// file to knowledge_chunks, and flips pending rows to done/failed.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/embeddings/batch/openai-client", () => ({
  uploadBatchInputFile: vi.fn(),
  createEmbeddingBatch: vi.fn(),
  getBatchStatus: vi.fn(),
  downloadBatchOutput: vi.fn(),
}));

import { reconcileEmbeddingBatches } from "@/lib/embeddings/batch/reconcile";
import {
  getBatchStatus,
  downloadBatchOutput,
} from "@/lib/embeddings/batch/openai-client";

interface DbState {
  pending: Array<{
    id: string;
    chunk_id: string;
    custom_id: string;
    status: string;
    batch_id: string | null;
    submitted_at: string | null;
    output_file_id?: string | null;
    error_detail?: string | null;
  }>;
  chunkUpdates: Array<{ id: string; embedding: string }>;
  pendingUpdates: Array<{ id?: string; payload: Record<string, unknown> }>;
}

function mockDb(state: DbState) {
  const db = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        _table: table,
        _eqMatch: {} as Record<string, string>,
        _notNullCol: undefined as string | undefined,
        _count: false,
        _statusIn: undefined as string[] | undefined,
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count === "exact") (builder as { _count: boolean })._count = true;
          return builder;
        },
        eq(col: string, val: string) {
          (builder as { _eqMatch: Record<string, string> })._eqMatch[col] = val;
          return builder;
        },
        in(col: string, vals: string[]) {
          if (col === "status") (builder as { _statusIn: string[] })._statusIn = vals;
          return builder;
        },
        not(col: string, op: string, _val: unknown) {
          if (op === "is") (builder as { _notNullCol: string })._notNullCol = col;
          return builder;
        },
        order() { return builder; },
        limit() {
          if (table === "pending_embedding") {
            const filtered = state.pending.filter((p) => {
              const m = (builder as { _eqMatch: Record<string, string> })._eqMatch;
              if (m.status && p.status !== m.status) return false;
              if (m.batch_id && p.batch_id !== m.batch_id) return false;
              return true;
            });
            return Promise.resolve({ data: filtered, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        update(payload: Record<string, unknown>) {
          if (table === "knowledge_chunks") {
            const k = {
              _id: null as string | null,
              eq(_col: string, id: string) {
                k._id = id;
                return k;
              },
              then(resolve: (v: { data: null; error: null }) => void) {
                if (k._id && typeof payload.embedding === "string") {
                  state.chunkUpdates.push({ id: k._id, embedding: payload.embedding });
                }
                resolve({ data: null, error: null });
              },
            };
            return k;
          }
          // pending_embedding update — supports both `.eq("id", x)` and
          // `.eq("batch_id", x).eq("status", "submitted")` chains.
          const u = {
            _id: undefined as string | undefined,
            _batchId: undefined as string | undefined,
            _statusFilter: undefined as string | undefined,
            eq(col: string, val: string) {
              if (col === "id") u._id = val;
              else if (col === "batch_id") u._batchId = val;
              else if (col === "status") u._statusFilter = val;
              return u;
            },
            then(resolve: (v: { data: null; error: null }) => void) {
              if (u._id) {
                state.pendingUpdates.push({ id: u._id, payload });
                const row = state.pending.find((p) => p.id === u._id);
                if (row && typeof payload.status === "string") row.status = payload.status;
              } else if (u._batchId) {
                for (const row of state.pending) {
                  if (row.batch_id !== u._batchId) continue;
                  if (u._statusFilter && row.status !== u._statusFilter) continue;
                  state.pendingUpdates.push({ id: row.id, payload });
                  if (typeof payload.status === "string") row.status = payload.status;
                }
              }
              resolve({ data: null, error: null });
            },
          };
          return u;
        },
        then(resolve: (v: { data: unknown[]; error: null; count?: number }) => void) {
          if (table === "pending_embedding") {
            const m = (builder as { _eqMatch: Record<string, string> })._eqMatch;
            const rows = state.pending.filter((p) => {
              if (m.status && p.status !== m.status) return false;
              if (m.batch_id && p.batch_id !== m.batch_id) return false;
              return true;
            });
            if ((builder as { _count: boolean })._count) {
              resolve({ data: rows, error: null, count: rows.length });
            } else {
              resolve({ data: rows, error: null });
            }
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileEmbeddingBatches", () => {
  it("no-op when no submitted batches", async () => {
    const db = mockDb({ pending: [], chunkUpdates: [], pendingUpdates: [] });
    const out = await reconcileEmbeddingBatches({ db });
    expect(out.batches_polled).toBe(0);
    expect(out.batches_completed).toBe(0);
    expect(getBatchStatus).not.toHaveBeenCalled();
  });

  it("leaves rows in 'submitted' while OpenAI batch is in_progress", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-A",
      status: "in_progress",
      output_file_id: null,
      error_file_id: null,
      errors: null,
    });
    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-A", submitted_at: "2026-06-04T00:00:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);
    const out = await reconcileEmbeddingBatches({ db });
    expect(out.batches_polled).toBe(1);
    expect(out.batches_completed).toBe(0);
    expect(state.chunkUpdates).toHaveLength(0);
    expect(state.pending[0]?.status).toBe("submitted");
  });

  it("applies a completed batch — writes embeddings and flips rows to done", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-B",
      status: "completed",
      output_file_id: "out-file-1",
      error_file_id: null,
      errors: null,
    });
    const outputLines = [
      JSON.stringify({
        custom_id: "cu1",
        response: { status_code: 200, body: { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }], model: "text-embedding-3-small" } },
        error: null,
      }),
      JSON.stringify({
        custom_id: "cu2",
        response: { status_code: 200, body: { data: [{ embedding: [0.4, 0.5, 0.6], index: 0 }], model: "text-embedding-3-small" } },
        error: null,
      }),
    ].join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-B", submitted_at: "2026-06-04T00:00:00Z" },
        { id: "p2", chunk_id: "c2", custom_id: "cu2", status: "submitted", batch_id: "batch-B", submitted_at: "2026-06-04T00:01:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);

    const out = await reconcileEmbeddingBatches({ db });

    expect(out.batches_polled).toBe(1);
    expect(out.batches_completed).toBe(1);
    expect(out.rows_succeeded).toBe(2);
    expect(out.rows_failed).toBe(0);
    expect(state.chunkUpdates).toHaveLength(2);
    expect(state.chunkUpdates.find((u) => u.id === "c1")?.embedding).toBe("[0.1,0.2,0.3]");
    expect(state.chunkUpdates.find((u) => u.id === "c2")?.embedding).toBe("[0.4,0.5,0.6]");
    expect(state.pending.every((p) => p.status === "done")).toBe(true);
  });

  it("marks a row failed when the output line is non-200", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-C",
      status: "completed",
      output_file_id: "out-file-2",
      error_file_id: null,
      errors: null,
    });
    const outputLines = [
      JSON.stringify({
        custom_id: "cu1",
        response: { status_code: 500, body: null },
        error: { message: "model_overloaded" },
      }),
    ].join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-C", submitted_at: "2026-06-04T00:00:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);

    const out = await reconcileEmbeddingBatches({ db });

    expect(out.rows_succeeded).toBe(0);
    expect(out.rows_failed).toBe(1);
    expect(state.chunkUpdates).toHaveLength(0);
    expect(state.pending[0]?.status).toBe("failed");
  });

  it("marks every row failed when the batch itself failed", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-D",
      status: "failed",
      output_file_id: null,
      error_file_id: null,
      errors: { data: [{ message: "input_validation_failed" }] },
    });
    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-D", submitted_at: "2026-06-04T00:00:00Z" },
        { id: "p2", chunk_id: "c2", custom_id: "cu2", status: "submitted", batch_id: "batch-D", submitted_at: "2026-06-04T00:01:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);

    const out = await reconcileEmbeddingBatches({ db });
    expect(out.rows_failed).toBe(2);
    expect(out.rows_succeeded).toBe(0);
    expect(state.chunkUpdates).toHaveLength(0);
  });
});
