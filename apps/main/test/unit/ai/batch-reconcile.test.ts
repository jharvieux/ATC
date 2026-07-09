// #1599 — reconcileSubmittedBatches / processOneResult idempotency.
//
// The bug: processOneResult flipped a row to completed/failed, attributed
// cost, and emitted an event with NO guard on the row's current status. A
// crash partway through streaming a batch's results (say at row 30 of 50)
// leaves the ai_batch_jobs row at status='submitted' — the next 5-minute
// reconcile re-streams the WHOLE batch from Anthropic (getAnthropicBatchResults
// always yields every row, there's no "resume from here" cursor), so rows
// 1-29 (already completed by the crashed run) would get cost re-incremented
// and a duplicate completion/failure event emitted.
//
// These tests simulate exactly that: a job whose request rows are a MIX of
// already-completed/already-failed (from "the run before the crash") and
// still-submitted (never reached), then feed getAnthropicBatchResults ALL
// of them again (as a real retry would) and assert cost/events only fire
// for the rows that were actually still 'submitted'.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryTable, makeBatchDb } from "./batch-db-mock";
import type { BatchResultRow } from "@/lib/ai/call-wrapper";

vi.mock("@/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/ai/call-wrapper", () => ({
  getAnthropicBatchStatus: vi.fn(),
  getAnthropicBatchResults: vi.fn(),
  logAndIncrement: vi.fn(),
}));

const { inngest } = await import("@/inngest/client");
const { getAnthropicBatchStatus, getAnthropicBatchResults, logAndIncrement } = await import(
  "@/lib/ai/call-wrapper"
);
const { reconcileSubmittedBatches } = await import("@/lib/ai/batch/reconcile");

const mockSend = vi.mocked(inngest.send);
const mockStatus = vi.mocked(getAnthropicBatchStatus);
const mockResults = vi.mocked(getAnthropicBatchResults);
const mockLogAndIncrement = vi.mocked(logAndIncrement);

function succeededRow(custom_id: string, text: string): BatchResultRow {
  return {
    custom_id,
    result: {
      type: "succeeded",
      message: {
        content: [{ type: "text", text }],
        usage: { input_tokens: 100, output_tokens: 50 },
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
      },
    },
  } as unknown as BatchResultRow;
}

function failedRow(custom_id: string): BatchResultRow {
  return {
    custom_id,
    result: { type: "errored", error: { type: "invalid_request", message: "bad prompt" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus.mockResolvedValue({
    batch_id: "batch-1",
    processing_status: "ended",
    request_counts: { processing: 0, succeeded: 1, errored: 0, canceled: 0, expired: 0 },
    ended_at: new Date().toISOString(),
  });
  mockLogAndIncrement.mockResolvedValue(undefined as never);
  mockSend.mockResolvedValue(undefined as never);
});

describe("reconcileSubmittedBatches — CAS idempotency (#1599)", () => {
  it("processes a fresh submitted row exactly once: cost attributed, event emitted", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 1, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      { id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });

    mockResults.mockImplementation(async function* () {
      yield succeededRow("req-1", "hello from anthropic");
    });

    const result = await reconcileSubmittedBatches({ db: db as never });

    expect(result.requests_succeeded).toBe(1);
    expect(mockLogAndIncrement).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(requests.rows[0]!.status).toBe("completed");
    expect(requests.rows[0]!.result_text).toBe("hello from anthropic");
  });

  it("does not double-count cost or re-emit for a row an earlier crashed run already completed", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 2, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    // req-1 simulates "already completed by the run that crashed before
    // finishing the whole batch." req-2 was never reached.
    const requests = new InMemoryTable([
      {
        id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1",
        caller_metadata: null, status: "completed", batch_job_id: "job-1",
        result_text: "already-processed-result", cost_cents: 42,
      },
      { id: "req-2", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-2", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });

    // Anthropic always returns the FULL result set for a batch — no
    // "only what's new" cursor. A retry re-streams both rows.
    mockResults.mockImplementation(async function* () {
      yield succeededRow("req-1", "a different result — must NOT overwrite req-1");
      yield succeededRow("req-2", "req-2 result");
    });

    const result = await reconcileSubmittedBatches({ db: db as never });

    // Only req-2 was actually claimed and processed this run.
    expect(result.requests_succeeded).toBe(1);
    expect(mockLogAndIncrement).toHaveBeenCalledTimes(1);
    expect(mockLogAndIncrement).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "t-1" }));
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ai.batch_request.completed.memory_extraction" }),
    );

    // req-1's already-recorded result/cost must survive untouched — the
    // CAS guard (.eq("status","submitted")) blocked the second write.
    const req1 = requests.rows.find((r) => r.id === "req-1")!;
    expect(req1.result_text).toBe("already-processed-result");
    expect(req1.cost_cents).toBe(42);

    const req2 = requests.rows.find((r) => r.id === "req-2")!;
    expect(req2.status).toBe("completed");
    expect(req2.result_text).toBe("req-2 result");
  });

  it("does not double-count or re-emit for a row an earlier run already marked failed", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "rag_pii_redaction", request_count: 2, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      {
        id: "req-1", tenant_id: "t-1", purpose: "rag_pii_redaction", custom_id: "req-1",
        caller_metadata: null, status: "failed", batch_job_id: "job-1", error_detail: "already-recorded-error",
      },
      { id: "req-2", tenant_id: "t-1", purpose: "rag_pii_redaction", custom_id: "req-2", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });

    mockResults.mockImplementation(async function* () {
      yield failedRow("req-1");
      yield failedRow("req-2");
    });

    const result = await reconcileSubmittedBatches({ db: db as never });

    expect(result.requests_failed).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ai.batch_request.failed.rag_pii_redaction" }),
    );

    const req1 = requests.rows.find((r) => r.id === "req-1")!;
    expect(req1.error_detail).toBe("already-recorded-error");
  });
});

// #1702 — the completion/failure event is now sent BEFORE the CAS-claim with a
// deterministic idempotency id. This closes the event-loss window (a send that
// threw after the row was flipped terminal was lost forever) without
// re-emitting for rows a prior run already finished.
describe("reconcileSubmittedBatches — event-loss fix (#1702)", () => {
  it("emits the completion event with a deterministic idempotency id (Inngest dedups the retry)", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 1, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      { id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });
    mockResults.mockImplementation(async function* () {
      yield succeededRow("req-1", "hi");
    });

    await reconcileSubmittedBatches({ db: db as never });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "batch-result-req-1",
        name: "ai.batch_request.completed.memory_extraction",
      }),
    );
  });

  it("emits the failure event with the same deterministic idempotency id", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 1, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      { id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });
    mockResults.mockImplementation(async function* () {
      yield failedRow("req-1");
    });

    await reconcileSubmittedBatches({ db: db as never });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "batch-result-req-1",
        name: "ai.batch_request.failed.memory_extraction",
      }),
    );
  });

  it("leaves the row claimable when the event send throws — never a terminal row with a lost event", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 1, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      { id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1", caller_metadata: null, status: "submitted", batch_job_id: "job-1" },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });
    mockResults.mockImplementation(async function* () {
      yield succeededRow("req-1", "hi");
    });
    // Inngest is down for this attempt.
    mockSend.mockRejectedValueOnce(new Error("inngest unavailable"));

    // WHY: because the send runs BEFORE the CAS-claim, a send failure must abort
    // the row while it is still 'submitted'. Under the old ordering the row was
    // already 'completed' and the event was gone — the next run's CAS returned 0
    // and never retried it. Here the row stays claimable so a retry re-sends
    // (deduped by id) and only then marks it terminal.
    await expect(reconcileSubmittedBatches({ db: db as never })).rejects.toThrow();

    expect(requests.rows[0]!.status).toBe("submitted");
    expect(mockLogAndIncrement).not.toHaveBeenCalled();
  });

  it("does not re-send the event for a row a prior run already completed (gate returns before send)", async () => {
    const jobs = new InMemoryTable([
      { id: "job-1", anthropic_batch_id: "batch-1", purpose: "memory_extraction", request_count: 1, status: "submitted", submitted_at: "2026-07-01T00:00:00Z" },
    ]);
    const requests = new InMemoryTable([
      {
        id: "req-1", tenant_id: "t-1", purpose: "memory_extraction", custom_id: "req-1",
        caller_metadata: null, status: "completed", batch_job_id: "job-1",
        result_text: "already-processed", cost_cents: 7,
      },
    ]);
    const db = makeBatchDb({ ai_batch_jobs: jobs, ai_batch_requests: requests });
    mockResults.mockImplementation(async function* () {
      yield succeededRow("req-1", "a re-stream that must NOT re-emit");
    });

    await reconcileSubmittedBatches({ db: db as never });

    // The status gate returns before the send, so no event fires on the retry.
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockLogAndIncrement).not.toHaveBeenCalled();
    expect(requests.rows[0]!.result_text).toBe("already-processed");
  });
});
