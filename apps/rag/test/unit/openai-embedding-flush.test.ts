// Issue #686 — flushPendingEmbeddings bundles pending rows into a single
// OpenAI batch and flips each row to 'submitted'.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/embeddings/batch/openai-client", () => ({
  uploadBatchInputFile: vi.fn(async (jsonl: string) => `file-${jsonl.length}`),
  createEmbeddingBatch: vi.fn(async (fileId: string) => `batch-${fileId}`),
  getBatchStatus: vi.fn(),
  downloadBatchOutput: vi.fn(),
}));

import { flushPendingEmbeddings } from "@/lib/embeddings/batch/flush";
import {
  uploadBatchInputFile,
  createEmbeddingBatch,
} from "@/lib/embeddings/batch/openai-client";

interface DbState {
  pending: Array<{
    id: string;
    chunk_id: string;
    content: string;
    custom_id: string;
    status: string;
    batch_id: string | null;
    openai_file_id: string | null;
    output_file_id: string | null;
    error_detail: string | null;
    queued_at: string;
    submitted_at: string | null;
    completed_at: string | null;
  }>;
  updates: Array<{ ids: string[]; payload: Record<string, unknown> }>;
}

function mockDb(state: DbState) {
  const db = {
    from(table: string) {
      if (table !== "pending_embedding") throw new Error(`unexpected table ${table}`);
      const builder = {
        _eqStatus: undefined as string | undefined,
        _count: false,
        select(_cols: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.count === "exact") this._count = true;
          return this;
        },
        eq(col: string, val: string) {
          if (col === "status") this._eqStatus = val;
          return this;
        },
        order() {
          return this;
        },
        limit(n: number) {
          if (this._count) {
            return Promise.resolve({ count: state.pending.filter((p) => p.status === "pending").length, error: null });
          }
          const rows = state.pending.filter((p) => p.status === (this._eqStatus ?? "pending")).slice(0, n);
          return Promise.resolve({ data: rows, error: null });
        },
        update(payload: Record<string, unknown>) {
          return {
            in(_col: string, ids: string[]) {
              state.updates.push({ ids, payload });
              for (const row of state.pending) {
                if (ids.includes(row.id) && typeof payload.status === "string") {
                  row.status = payload.status;
                  row.batch_id = (payload.batch_id as string) ?? row.batch_id;
                  row.openai_file_id = (payload.openai_file_id as string) ?? row.openai_file_id;
                  row.submitted_at = (payload.submitted_at as string) ?? row.submitted_at;
                }
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
        then(resolve: (v: { data: unknown[]; error: null; count?: number }) => void) {
          if (this._count) {
            resolve({ data: [], error: null, count: state.pending.filter((p) => p.status === "pending").length });
            return;
          }
          const rows = state.pending.filter((p) => p.status === (this._eqStatus ?? "pending"));
          resolve({ data: rows, error: null });
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

describe("flushPendingEmbeddings", () => {
  it("returns {flushed:0, remaining:0} when no pending rows", async () => {
    const db = mockDb({ pending: [], updates: [] });
    const out = await flushPendingEmbeddings({ db });
    expect(out.flushed).toBe(0);
    expect(out.remaining).toBe(0);
    expect(uploadBatchInputFile).not.toHaveBeenCalled();
    expect(createEmbeddingBatch).not.toHaveBeenCalled();
  });

  it("uploads a JSONL file, creates a batch, and flips rows to submitted", async () => {
    const state: DbState = {
      pending: [
        { id: "p1", chunk_id: "c1", content: "alpha", custom_id: "cu1", status: "pending", batch_id: null, openai_file_id: null, output_file_id: null, error_detail: null, queued_at: "2026-06-04T00:00:00Z", submitted_at: null, completed_at: null },
        { id: "p2", chunk_id: "c2", content: "beta", custom_id: "cu2", status: "pending", batch_id: null, openai_file_id: null, output_file_id: null, error_detail: null, queued_at: "2026-06-04T00:01:00Z", submitted_at: null, completed_at: null },
      ],
      updates: [],
    };
    const db = mockDb(state);

    const out = await flushPendingEmbeddings({ db });

    expect(out.flushed).toBe(2);
    expect(out.batch_id).toBeDefined();
    expect(out.openai_file_id).toBeDefined();
    expect(uploadBatchInputFile).toHaveBeenCalledOnce();
    const jsonl = (uploadBatchInputFile as unknown as { mock: { calls: [string][] } }).mock.calls[0]?.[0];
    expect(jsonl).toBeDefined();
    const lines = (jsonl as string).split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as { custom_id: string; method: string; url: string; body: { model: string; input: string; dimensions: number } };
    expect(parsed.custom_id).toBe("cu1");
    expect(parsed.method).toBe("POST");
    expect(parsed.url).toBe("/v1/embeddings");
    expect(parsed.body.input).toBe("alpha");

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]?.ids).toEqual(["p1", "p2"]);
    expect(state.updates[0]?.payload.status).toBe("submitted");
    expect(state.pending.every((p) => p.status === "submitted")).toBe(true);
  });

  it("chunks the status-flip into ≤200-id updates for a large batch — one OpenAI batch (#805)", async () => {
    // Regression guard for #805: an un-chunked .in() with up to 2,000 ids exceeds
    // PostgREST's URL limit; the flip must be chunked while still creating ONE
    // OpenAI batch per flush. 450 ids → 3 chunks (200, 200, 50).
    const pending = Array.from({ length: 450 }, (_, i) => ({
      id: `p${i}`, chunk_id: `c${i}`, content: `t${i}`, custom_id: `cu${i}`,
      status: "pending", batch_id: null, openai_file_id: null, output_file_id: null,
      error_detail: null, queued_at: `2026-06-04T00:00:00.${String(i).padStart(3, "0")}Z`,
      submitted_at: null, completed_at: null,
    }));
    const state: DbState = { pending, updates: [] };
    const db = mockDb(state);

    const out = await flushPendingEmbeddings({ db });

    expect(out.flushed).toBe(450);
    expect(uploadBatchInputFile).toHaveBeenCalledOnce();
    expect(createEmbeddingBatch).toHaveBeenCalledOnce();
    expect(state.updates).toHaveLength(3);
    expect(state.updates.every((u) => u.ids.length <= 200)).toBe(true);
    expect(state.updates.flatMap((u) => u.ids)).toHaveLength(450);
    expect(state.pending.every((p) => p.status === "submitted")).toBe(true);
  });
});
