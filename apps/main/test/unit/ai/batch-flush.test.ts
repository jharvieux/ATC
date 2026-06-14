// flushPendingForPurpose behavior tests.
// Covers: count-query DB error surfaces as throw (D-091 #1044),
// happy-path return values, and early-exit when nothing is pending.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPendingForPurpose } from "@/lib/ai/batch/flush";

vi.mock("@/lib/ai/call-wrapper", () => ({
  submitAnthropicBatch: vi.fn(),
}));

const { submitAnthropicBatch } = await import("@/lib/ai/call-wrapper");
const mockSubmit = vi.mocked(submitAnthropicBatch);

const PURPOSE = "precruise_generation" as const;

function makePendingRow(n: number) {
  return {
    id: `row-${n}`,
    custom_id: `custom-${n}`,
    request_params: { model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [] },
  };
}

function makeDb(opts: {
  pendingRows?: ReturnType<typeof makePendingRow>[];
  pendingError?: { message: string };
  countValue?: number | null;
  countError?: { message: string };
  jobId?: string;
}) {
  const {
    pendingRows = [],
    pendingError = null,
    countValue = pendingRows.length,
    countError = null,
    jobId = "job-uuid",
  } = opts;

  const buildChain = (result: Promise<unknown>) => {
    const chain: Record<string, unknown> = {};
    const then = result.then.bind(result);
    const catchFn = result.catch.bind(result);
    const methods = ["eq", "order", "limit", "in", "update", "select", "insert", "single"];
    for (const m of methods) chain[m] = () => chain;
    chain["then"] = then;
    chain["catch"] = catchFn;
    return chain;
  };

  return {
    from(table: string) {
      if (table === "ai_batch_requests") {
        return {
          select(cols: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.count === "exact") {
              const result = Promise.resolve({ count: countValue, error: countError });
              return buildChain(result);
            }
            const result = Promise.resolve({
              data: pendingError ? null : pendingRows,
              error: pendingError,
            });
            return buildChain(result);
          },
          update(_payload: unknown) {
            const result = Promise.resolve({ data: null, error: null });
            return buildChain(result);
          },
        };
      }

      if (table === "ai_batch_jobs") {
        return {
          insert(_payload: unknown) {
            return {
              select: () => ({
                single: async () => ({ data: { id: jobId }, error: null }),
              }),
            };
          },
        };
      }

      throw new Error(`makeDb: unexpected table "${table}"`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmit.mockResolvedValue({
    batch_id: "batch-abc",
    request_count: 1,
    processing_status: "in_progress",
  });
});

describe("flushPendingForPurpose", () => {
  it("returns early with zero counts when no rows are pending", async () => {
    const db = makeDb({ pendingRows: [] });
    const result = await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });
    expect(result).toEqual({ flushed: 0, remaining: 0 });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("throws when the count query returns a DB error (D-091 #1044)", async () => {
    // Without the fix, countErr is ignored and remaining silently becomes 0.
    // With the fix, this throws so the cron doesn't think the backlog is empty.
    const db = makeDb({
      pendingRows: [makePendingRow(1)],
      countError: { message: "connection timeout" },
    });
    await expect(
      flushPendingForPurpose({ purpose: PURPOSE, db: db as never }),
    ).rejects.toThrow("remaining count failed: connection timeout");
  });

  it("returns flushed=N and remaining=total-N after a successful batch", async () => {
    const rows = [makePendingRow(1), makePendingRow(2)];
    // Simulate 5 total pending; after slicing 2, 3 remain.
    const db = makeDb({ pendingRows: rows, countValue: 5 });
    const result = await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });
    expect(result.flushed).toBe(2);
    expect(result.remaining).toBe(3);
    expect(result.batch_id).toBe("batch-abc");
    expect(mockSubmit).toHaveBeenCalledOnce();
  });

  it("throws when the pending row SELECT fails", async () => {
    const db = makeDb({ pendingError: { message: "relation does not exist" } });
    await expect(
      flushPendingForPurpose({ purpose: PURPOSE, db: db as never }),
    ).rejects.toThrow("pending lookup failed: relation does not exist");
  });
});
