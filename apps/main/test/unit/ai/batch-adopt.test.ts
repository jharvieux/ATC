// #1696 — adoptStrandedBatches behavior tests.
//
// Intent: a crash between a successful Anthropic submit and the ai_batch_jobs
// insert/link leaves rows 'submitted' with anthropic_batch_id set but
// batch_job_id NULL — a paid-for batch nothing polls. The sweep must recover
// those rows into a job (find-or-create) WITHOUT resubmitting or orphaning the
// batch, and must never touch rows that are still healthily in flight (a flush
// that just submitted) or rows in any other state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { adoptStrandedBatches } from "@/lib/ai/batch/adopt";
import { InMemoryTable, makeBatchDb } from "./batch-db-mock";

const PURPOSE = "precruise_generation" as const;
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();
const NOW = new Date().toISOString();

function strandedRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `row-${n}`,
    tenant_id: "t-1",
    purpose: PURPOSE,
    status: "submitted",
    custom_id: `custom-${n}`,
    request_params: {},
    anthropic_batch_id: "batch-live-1",
    batch_job_id: null,
    submitted_at: HOUR_AGO,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adoptStrandedBatches", () => {
  it("does nothing when there are no stranded rows", async () => {
    const requests = new InMemoryTable([]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result).toEqual({ batches_adopted: 0, requests_adopted: 0 });
    expect(jobs.rows).toHaveLength(0);
  });

  it("creates a job and links stranded rows when no job exists yet (crash before job insert)", async () => {
    const requests = new InMemoryTable([strandedRow(1), strandedRow(2), strandedRow(3)]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result.batches_adopted).toBe(1);
    expect(result.requests_adopted).toBe(3);
    // Exactly one job, carrying the live batch id and the recovered row count.
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]!.anthropic_batch_id).toBe("batch-live-1");
    expect(jobs.rows[0]!.request_count).toBe(3);
    expect(jobs.rows[0]!.status).toBe("submitted");
    // Every stranded row is now linked to that job.
    const jobId = jobs.rows[0]!.id;
    expect(requests.rows.every((r) => r.batch_job_id === jobId)).toBe(true);
  });

  it("links to the EXISTING job when one already exists (crash after job insert, before link)", async () => {
    const requests = new InMemoryTable([strandedRow(1), strandedRow(2)]);
    const jobs = new InMemoryTable([
      { id: "job-existing", anthropic_batch_id: "batch-live-1", purpose: PURPOSE, request_count: 2, status: "submitted" },
    ]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result.batches_adopted).toBe(1);
    expect(result.requests_adopted).toBe(2);
    // No duplicate job created — reused the existing one.
    expect(jobs.rows).toHaveLength(1);
    expect(requests.rows.every((r) => r.batch_job_id === "job-existing")).toBe(true);
  });

  it("does NOT adopt rows stranded more recently than the threshold (a live flush mid-insert)", async () => {
    // submitted_at = now: a healthy flush that just submitted and is about to
    // link. Adopting it would race the flush and could double-create the job.
    const requests = new InMemoryTable([strandedRow(1, { submitted_at: NOW })]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result).toEqual({ batches_adopted: 0, requests_adopted: 0 });
    expect(jobs.rows).toHaveLength(0);
    expect(requests.rows[0]!.batch_job_id).toBeNull();
  });

  it("ignores rows that aren't actually stranded (pending, already linked, or no batch id)", async () => {
    const requests = new InMemoryTable([
      strandedRow(1, { status: "pending", anthropic_batch_id: null }), // never submitted
      strandedRow(2, { batch_job_id: "already-linked" }), // link succeeded
      strandedRow(3, { anthropic_batch_id: null }), // claimed but crashed before stamp
    ]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result).toEqual({ batches_adopted: 0, requests_adopted: 0 });
    expect(jobs.rows).toHaveLength(0);
  });

  it("adopts each distinct Anthropic batch into its own job", async () => {
    const requests = new InMemoryTable([
      strandedRow(1, { anthropic_batch_id: "batch-A" }),
      strandedRow(2, { anthropic_batch_id: "batch-A" }),
      strandedRow(3, { anthropic_batch_id: "batch-B" }),
    ]);
    const jobs = new InMemoryTable([]);
    const db = makeBatchDb({ ai_batch_requests: requests, ai_batch_jobs: jobs });

    const result = await adoptStrandedBatches({ db: db as never });

    expect(result.batches_adopted).toBe(2);
    expect(result.requests_adopted).toBe(3);
    expect(jobs.rows).toHaveLength(2);
    expect(new Set(jobs.rows.map((j) => j.anthropic_batch_id))).toEqual(new Set(["batch-A", "batch-B"]));
  });
});

describe("adoptStrandedBatches — concurrent job creation (23505)", () => {
  it("re-selects the winning job instead of failing when a UNIQUE conflict races the insert", async () => {
    // A concurrent adopter/flush inserted the job row between our lookup and our
    // insert. The DB rejects our insert with 23505; we must recover the winner's
    // id and link to it, not throw.
    const linkedIds: string[] = [];
    let insertAttempts = 0;
    const db = {
      from(table: string) {
        if (table === "ai_batch_requests") {
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  not: () => ({
                    lt: () => ({
                      order: () => ({
                        limit: () =>
                          Promise.resolve({
                            data: [
                              { id: "row-1", purpose: PURPOSE, anthropic_batch_id: "batch-race" },
                              { id: "row-2", purpose: PURPOSE, anthropic_batch_id: "batch-race" },
                            ],
                            error: null,
                          }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
            update: () => ({
              in: () => ({
                eq: () => ({
                  is: () => ({
                    select: () => {
                      linkedIds.push("row-1", "row-2");
                      return Promise.resolve({ data: [{ id: "row-1" }, { id: "row-2" }], error: null });
                    },
                  }),
                }),
              }),
            }),
          };
        }
        // ai_batch_jobs: first lookup finds nothing, insert 23505s, re-select wins.
        return {
          select: (_cols: string) => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
              single: () => Promise.resolve({ data: { id: "job-winner" }, error: null }),
            }),
          }),
          insert: () => ({
            select: () => ({
              single: () => {
                insertAttempts++;
                return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
              },
            }),
          }),
        };
      },
    };

    const result = await adoptStrandedBatches({ db: db as never });

    expect(insertAttempts).toBe(1);
    expect(result.batches_adopted).toBe(1);
    expect(result.requests_adopted).toBe(2);
    expect(linkedIds).toEqual(["row-1", "row-2"]);
  });
});
