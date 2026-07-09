// flushPendingForPurpose behavior tests.
// Covers: count-query DB error surfaces as throw (D-091 #1044),
// happy-path return values, early-exit when nothing is pending, and
// #1599's claim-before-send guard (a submit failure must release the
// claim so the next flush retries instead of resubmitting or stranding
// the rows).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPendingForPurpose } from "@/lib/ai/batch/flush";
import { InMemoryTable, makeBatchDb } from "./batch-db-mock";

vi.mock("@/lib/ai/call-wrapper", () => ({
  submitAnthropicBatch: vi.fn(),
}));

const { submitAnthropicBatch } = await import("@/lib/ai/call-wrapper");
const mockSubmit = vi.mocked(submitAnthropicBatch);

const PURPOSE = "precruise_generation" as const;

function makePendingRow(n: number) {
  return {
    id: `row-${n}`,
    tenant_id: "t-1",
    purpose: PURPOSE,
    status: "pending",
    custom_id: `custom-${n}`,
    request_params: { model: "claude-haiku-4-5-20251001", max_tokens: 100, messages: [] },
    batch_job_id: null,
  };
}

// Legacy DB double for the tests that only exercise the SELECT-side
// error/early-exit paths and never reach the claim/submit/link logic.
function makeSelectOnlyDb(opts: {
  pendingRows?: ReturnType<typeof makePendingRow>[];
  pendingError?: { message: string };
  countValue?: number | null;
  countError?: { message: string };
}) {
  const { pendingRows = [], pendingError = null, countValue = pendingRows.length, countError = null } = opts;

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
          select(_cols: string, selOpts?: { count?: string; head?: boolean }) {
            if (selOpts?.count === "exact") {
              return buildChain(Promise.resolve({ count: countValue, error: countError }));
            }
            return buildChain(Promise.resolve({ data: pendingError ? null : pendingRows, error: pendingError }));
          },
        };
      }
      throw new Error(`makeSelectOnlyDb: unexpected table "${table}"`);
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
    const db = makeSelectOnlyDb({ pendingRows: [] });
    const result = await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });
    expect(result).toEqual({ flushed: 0, remaining: 0 });
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("throws when the count query returns a DB error (D-091 #1044)", async () => {
    // Without the fix, countErr is ignored and remaining silently becomes 0.
    // With the fix, this throws so the cron doesn't think the backlog is empty.
    const db = makeSelectOnlyDb({
      pendingRows: [makePendingRow(1)],
      countError: { message: "connection timeout" },
    });
    await expect(
      flushPendingForPurpose({ purpose: PURPOSE, db: db as never }),
    ).rejects.toThrow("remaining count failed: connection timeout");
  });

  it("throws when the pending row SELECT fails", async () => {
    const db = makeSelectOnlyDb({ pendingError: { message: "relation does not exist" } });
    await expect(
      flushPendingForPurpose({ purpose: PURPOSE, db: db as never }),
    ).rejects.toThrow("pending lookup failed: relation does not exist");
  });
});

describe("flushPendingForPurpose — claim-before-send (#1599)", () => {
  it("returns flushed=N and remaining=total-N, and links claimed rows to the job", async () => {
    const rows = [makePendingRow(1), makePendingRow(2), makePendingRow(3), makePendingRow(4), makePendingRow(5)];
    const requests = new InMemoryTable(rows);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });

    expect(result.flushed).toBe(5);
    expect(result.remaining).toBe(0);
    expect(result.batch_id).toBe("batch-abc");
    expect(mockSubmit).toHaveBeenCalledOnce();
    // All claimed rows are submitted and linked to the newly-created job.
    expect(requests.rows.every((r) => r.status === "submitted")).toBe(true);
    expect(new Set(requests.rows.map((r) => r.batch_job_id)).size).toBe(1);
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.anthropic_batch_id).toBe("batch-abc");
    // #1696 — every row also carries the Anthropic batch id + a submit time so
    // the adoption sweep can recover it if a crash strands it before linking.
    expect(requests.rows.every((r) => r.anthropic_batch_id === "batch-abc")).toBe(true);
    expect(requests.rows.every((r) => typeof r.submitted_at === "string")).toBe(true);
  });

  it("stamps anthropic_batch_id onto the rows BEFORE inserting the job (#1696)", async () => {
    const requests = new InMemoryTable([makePendingRow(1)]);
    const jobs = new InMemoryTable([]);
    const inner = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    // Probe the request-row state at the instant the job insert happens. The
    // fix's guarantee is stamp-then-insert: if the process died between submit
    // and insert, the row must already carry the batch id so adoption can
    // recover it. So at insert time the row MUST already be stamped.
    let stampedAtInsertTime: unknown = "insert-never-called";
    const db = {
      from(table: string) {
        const t = inner.from(table);
        if (table === "ai_batch_jobs") {
          const origInsert = t.insert.bind(t);
          return Object.assign(t, {
            insert(payload: Record<string, unknown>) {
              stampedAtInsertTime = requests.rows[0]!.anthropic_batch_id;
              return origInsert(payload);
            },
          });
        }
        return t;
      },
    };

    mockSubmit.mockResolvedValueOnce({ batch_id: "batch-xyz", request_count: 1, processing_status: "in_progress" });
    await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });

    expect(stampedAtInsertTime).toBe("batch-xyz");
  });

  it("claims rows to 'submitted' BEFORE calling Anthropic, not after", async () => {
    const requests = new InMemoryTable([makePendingRow(1)]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    mockSubmit.mockImplementation(async () => {
      // At the moment Anthropic is "called", the row must already be
      // claimed — otherwise a crash right here would leave it 'pending'
      // and a retry would resubmit it.
      expect(requests.rows[0]!.status).toBe("submitted");
      return { batch_id: "batch-abc", request_count: 1, processing_status: "in_progress" };
    });

    await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });
    expect(mockSubmit).toHaveBeenCalledOnce();
  });

  it("releases the claim back to 'pending' when submitAnthropicBatch throws, so a retry can resubmit", async () => {
    const requests = new InMemoryTable([makePendingRow(1), makePendingRow(2)]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });
    mockSubmit.mockRejectedValue(new Error("anthropic 503"));

    await expect(flushPendingForPurpose({ purpose: PURPOSE, db: db as never })).rejects.toThrow("anthropic 503");

    // Released back to pending — NOT stuck at 'submitted' with no job,
    // and no ai_batch_jobs row was created (submit never succeeded).
    expect(requests.rows.every((r) => r.status === "pending")).toBe(true);
    expect(requests.rows.every((r) => r.batch_job_id === null)).toBe(true);
    expect(jobs.rows).toHaveLength(0);
  });

  it("a released claim can be resubmitted by the next flush call (no double-submit, no stranded rows)", async () => {
    const requests = new InMemoryTable([makePendingRow(1)]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    mockSubmit.mockRejectedValueOnce(new Error("transient network failure"));
    await expect(flushPendingForPurpose({ purpose: PURPOSE, db: db as never })).rejects.toThrow(
      "transient network failure",
    );

    // Retry: the row is 'pending' again, so it's picked up and submitted
    // exactly once overall — not zero times (stranded) and not twice
    // (double-billed).
    mockSubmit.mockResolvedValueOnce({ batch_id: "batch-retry", request_count: 1, processing_status: "in_progress" });
    const result = await flushPendingForPurpose({ purpose: PURPOSE, db: db as never });

    expect(result.flushed).toBe(1);
    expect(result.batch_id).toBe("batch-retry");
    expect(mockSubmit).toHaveBeenCalledTimes(2);
    expect(requests.rows[0]!.status).toBe("submitted");
    expect(jobs.rows).toHaveLength(1);
  });
});
