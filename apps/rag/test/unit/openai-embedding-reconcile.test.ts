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

// Stub out the cost-log helper so reconcile tests focus on chunk/state
// updates. The cost-log behavior is covered by embedding-cost-log.test.ts.
vi.mock("@/lib/embeddings/cost-log", () => ({
  logEmbeddingCall: vi.fn(async () => undefined),
}));

import { reconcileEmbeddingBatches } from "@/lib/embeddings/batch/reconcile";
import {
  getBatchStatus,
  downloadBatchOutput,
} from "@/lib/embeddings/batch/openai-client";
import { logEmbeddingCall } from "@/lib/embeddings/cost-log";

interface DbState {
  pending: Array<{
    id: string;
    chunk_id: string;
    custom_id: string;
    status: string;
    batch_id: string | null;
    submitted_at: string | null;
    tenant_id?: string | null;
    output_file_id?: string | null;
    error_detail?: string | null;
  }>;
  chunkUpdates: Array<{ id: string; embedding: string }>;
  pendingUpdates: Array<{ id?: string; payload: Record<string, unknown> }>;
  failChunkIds?: Set<string>;
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
              then(resolve: (v: { data: null; error: { message: string } | null }) => void) {
                if (k._id && state.failChunkIds?.has(k._id)) {
                  resolve({ data: null, error: { message: "chunk write failed" } });
                  return;
                }
                if (k._id && typeof payload.embedding === "string") {
                  state.chunkUpdates.push({ id: k._id, embedding: payload.embedding });
                }
                resolve({ data: null, error: null });
              },
            };
            return k;
          }
          // pending_embedding update — supports both `.eq("id", x)` and
          // `.eq("batch_id", x).eq("status", "submitted").select("id")` chains.
          const u = {
            _id: undefined as string | undefined,
            _inIds: undefined as string[] | undefined,
            _batchId: undefined as string | undefined,
            _statusFilter: undefined as string | undefined,
            _selectChained: false,
            eq(col: string, val: string) {
              if (col === "id") u._id = val;
              else if (col === "batch_id") u._batchId = val;
              else if (col === "status") u._statusFilter = val;
              return u;
            },
            in(col: string, vals: string[]) {
              if (col === "id") u._inIds = vals;
              return u;
            },
            select(_cols: string) {
              u._selectChained = true;
              return u;
            },
            then(
              resolve: (v: { data: { id: string }[] | null; error: null }) => void,
            ) {
              const affected: { id: string }[] = [];
              const applyToId = (id: string) => {
                state.pendingUpdates.push({ id, payload });
                const row = state.pending.find((p) => p.id === id);
                if (row && typeof payload.status === "string") row.status = payload.status;
                if (row) affected.push({ id: row.id });
              };
              if (u._id) {
                applyToId(u._id);
              } else if (u._inIds) {
                for (const id of u._inIds) applyToId(id);
              } else if (u._batchId) {
                for (const row of state.pending) {
                  if (row.batch_id !== u._batchId) continue;
                  if (u._statusFilter && row.status !== u._statusFilter) continue;
                  state.pendingUpdates.push({ id: row.id, payload });
                  affected.push({ id: row.id });
                  if (typeof payload.status === "string") row.status = payload.status;
                }
              }
              resolve({ data: u._selectChained ? affected : null, error: null });
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

  it("logs embedding cost with tenant_id from pending_embedding row (#689)", async () => {
    (logEmbeddingCall as unknown as { mockClear: () => void }).mockClear();
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-tenant",
      status: "completed",
      output_file_id: "out-tenant",
      error_file_id: null,
      errors: null,
    });
    const outputLines = [
      JSON.stringify({
        custom_id: "cu-t1",
        response: {
          status_code: 200,
          body: {
            data: [{ embedding: [0.1], index: 0 }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 1234 },
          },
        },
        error: null,
      }),
      JSON.stringify({
        custom_id: "cu-platform",
        response: {
          status_code: 200,
          body: {
            data: [{ embedding: [0.2], index: 0 }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 99 },
          },
        },
        error: null,
      }),
    ].join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = {
      pending: [
        { id: "p-t1", chunk_id: "c-t1", custom_id: "cu-t1", status: "submitted", batch_id: "batch-tenant", submitted_at: "2026-06-04T00:00:00Z", tenant_id: "tenant-A" },
        { id: "p-platform", chunk_id: "c-platform", custom_id: "cu-platform", status: "submitted", batch_id: "batch-tenant", submitted_at: "2026-06-04T00:01:00Z", tenant_id: null },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);

    await reconcileEmbeddingBatches({ db });

    const calls = (logEmbeddingCall as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls;
    expect(calls).toHaveLength(2);
    const tenantCall = calls.find((c) => (c[0] as Record<string, unknown>).tenant_id === "tenant-A");
    const platformCall = calls.find((c) => (c[0] as Record<string, unknown>).tenant_id === null);
    expect(tenantCall).toBeDefined();
    expect(platformCall).toBeDefined();
    expect((tenantCall![0] as Record<string, unknown>).source).toBe("batch");
    expect((tenantCall![0] as Record<string, unknown>).input_tokens).toBe(1234);
    expect((platformCall![0] as Record<string, unknown>).input_tokens).toBe(99);
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

  it("treats 'cancelling' as transient — leaves rows in submitted", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-cancelling",
      status: "cancelling",
      output_file_id: null,
      error_file_id: null,
      errors: null,
    });
    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-cancelling", submitted_at: "2026-06-04T00:00:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);
    const out = await reconcileEmbeddingBatches({ db });
    expect(out.batches_polled).toBe(1);
    expect(out.batches_completed).toBe(0);
    expect(out.rows_failed).toBe(0);
    expect(state.pending[0]?.status).toBe("submitted");
  });

  it("flips rows to failed when status='completed' but no output_file_id", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-no-output",
      status: "completed",
      output_file_id: null,
      error_file_id: null,
      errors: null,
    });
    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-no-output", submitted_at: "2026-06-04T00:00:00Z" },
        { id: "p2", chunk_id: "c2", custom_id: "cu2", status: "submitted", batch_id: "batch-no-output", submitted_at: "2026-06-04T00:01:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);
    const out = await reconcileEmbeddingBatches({ db });
    expect(out.rows_failed).toBe(2);
    expect(out.rows_succeeded).toBe(0);
    expect(state.chunkUpdates).toHaveLength(0);
    expect(state.pending.every((p) => p.status === "failed")).toBe(true);
    const detail = state.pendingUpdates.find((u) => (u.payload as Record<string, unknown>).error_detail)?.payload as Record<string, unknown>;
    expect(detail?.error_detail).toBe("completed_without_output_file");
  });

  it("marks a row failed if its custom_id has no matching output line", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-partial",
      status: "completed",
      output_file_id: "out-partial",
      error_file_id: null,
      errors: null,
    });
    // Only one output line for cu1; cu2 is missing.
    const outputLines = [
      JSON.stringify({
        custom_id: "cu1",
        response: { status_code: 200, body: { data: [{ embedding: [0.7], index: 0 }], model: "text-embedding-3-small" } },
        error: null,
      }),
    ].join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-partial", submitted_at: "2026-06-04T00:00:00Z" },
        { id: "p2", chunk_id: "c2", custom_id: "cu2", status: "submitted", batch_id: "batch-partial", submitted_at: "2026-06-04T00:01:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
    };
    const db = mockDb(state);

    const out = await reconcileEmbeddingBatches({ db });
    expect(out.rows_succeeded).toBe(1);
    expect(out.rows_failed).toBe(1);
    expect(state.pending.find((p) => p.id === "p1")?.status).toBe("done");
    expect(state.pending.find((p) => p.id === "p2")?.status).toBe("failed");
    const p2Update = state.pendingUpdates.find((u) => u.id === "p2");
    expect((p2Update?.payload as Record<string, unknown>).error_detail).toBe("no_output_line_for_custom_id");
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

  it("bulk-applies a >1000-row batch in concurrency waves, isolating failures (#789)", async () => {
    const N = 1200;
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-big",
      status: "completed",
      output_file_id: "out-big",
      error_file_id: null,
      errors: null,
    });
    const pending = Array.from({ length: N }, (_, i) => ({
      id: `p${i}`,
      chunk_id: `c${i}`,
      custom_id: `cu${i}`,
      status: "submitted",
      batch_id: "batch-big",
      submitted_at: "2026-06-04T00:00:00Z",
    }));
    // Three rows come back non-200 — they must fail without touching the rest.
    const failIdx = new Set([7, 500, 1199]);
    const outputLines = pending
      .map((p, i) =>
        failIdx.has(i)
          ? JSON.stringify({ custom_id: p.custom_id, response: { status_code: 500, body: null }, error: { message: "model_overloaded" } })
          : JSON.stringify({ custom_id: p.custom_id, response: { status_code: 200, body: { data: [{ embedding: [i / 1000], index: 0 }], model: "text-embedding-3-small" } }, error: null }),
      )
      .join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = { pending, chunkUpdates: [], pendingUpdates: [] };
    const db = mockDb(state);

    const out = await reconcileEmbeddingBatches({ db });

    expect(out.rows_succeeded).toBe(N - 3);
    expect(out.rows_failed).toBe(3);
    expect(state.chunkUpdates).toHaveLength(N - 3);
    expect(state.pending.filter((p) => p.status === "done")).toHaveLength(N - 3);
    expect(state.pending.filter((p) => p.status === "failed")).toHaveLength(3);
    expect(state.pending.find((p) => p.id === "p500")?.status).toBe("failed");
    expect(state.pending.find((p) => p.id === "p501")?.status).toBe("done");
  });

  it("aborts before any status flip when a chunk write fails — rows stay submitted (#789)", async () => {
    (getBatchStatus as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      id: "batch-werr",
      status: "completed",
      output_file_id: "out-werr",
      error_file_id: null,
      errors: null,
    });
    const outputLines = [
      JSON.stringify({ custom_id: "cu1", response: { status_code: 200, body: { data: [{ embedding: [0.1], index: 0 }], model: "text-embedding-3-small" } }, error: null }),
      JSON.stringify({ custom_id: "cu2", response: { status_code: 200, body: { data: [{ embedding: [0.2], index: 0 }], model: "text-embedding-3-small" } }, error: null }),
    ].join("\n");
    (downloadBatchOutput as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(outputLines);

    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", custom_id: "cu1", status: "submitted", batch_id: "batch-werr", submitted_at: "2026-06-04T00:00:00Z" },
        { id: "p2", chunk_id: "c2", custom_id: "cu2", status: "submitted", batch_id: "batch-werr", submitted_at: "2026-06-04T00:01:00Z" },
      ],
      chunkUpdates: [],
      pendingUpdates: [],
      failChunkIds: new Set(["c2"]),
    };
    const db = mockDb(state);

    // The c2 chunk write fails → the wave rejects → reconcile throws before any
    // status flip runs, so both rows stay 'submitted' for the next run to retry.
    await expect(reconcileEmbeddingBatches({ db })).rejects.toThrow();
    expect(state.pending.every((p) => p.status === "submitted")).toBe(true);
    expect(
      state.pendingUpdates.filter((u) => (u.payload as Record<string, unknown>).status === "done"),
    ).toHaveLength(0);
  });
});
