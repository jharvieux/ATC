// §23.7 / #1611 — email_retry_content purge cron.
//
// Tests verify WHY the behavior matters:
//   - Only EXPIRED rows are deleted; rows still inside their TTL are retained
//     (the whole point of the cron is bounded PII retention, not truncation).
//   - Deletes are BATCHED and BOUNDED via select-then-delete-by-PK, looping until
//     a batch comes back short — a single `.delete().select()` is subject to
//     PostgREST's max-rows cap, which would silently leave PII past its TTL.
//   - STAGING_MODE records the skip and returns early (no destructive work on the
//     shared staging DB).
//   - Fail-loud: a DB error THROWS so the Inngest run surfaces as failed for
//     alerting — a silently-degraded purge is how PII quietly outlives its window.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

interface Row {
  email_log_id: string;
  expires_at: string;
}
interface OutboxRow {
  email_log_id: string;
  provider_snapshot_expires_at: string;
  provider_request_body: string | null;
  retry_content_snapshot: Record<string, unknown> | null;
}
let rows: Row[];
let outboxRows: OutboxRow[];
let selectErr: { message: string } | null;
let deleteErr: { message: string } | null;
let updateErr: { message: string } | null;
let deleteCalls: number;
let updateCalls: number;
const inserts: string[] = [];

function makeChain(table: string) {
  return {
    select() {
      let cutoff = "";
      const chain = {
        not() {
          return chain;
        },
        lt(_col: string, c: string) {
          cutoff = c;
          return chain;
        },
        limit(n: number) {
          if (selectErr) return Promise.resolve({ data: null, error: selectErr });
          if (table === "email_provider_dispatch") {
            const matched = outboxRows
              .filter((row) => row.provider_request_body && row.provider_snapshot_expires_at < cutoff)
              .slice(0, n);
            return Promise.resolve({
              data: matched.map((row) => ({ email_log_id: row.email_log_id })),
              error: null,
            });
          }
          const matched = rows.filter((r) => r.expires_at < cutoff).slice(0, n);
          return Promise.resolve({ data: matched.map((r) => ({ email_log_id: r.email_log_id })), error: null });
        },
      };
      return chain;
    },
    delete() {
      return {
        in(_col: string, ids: string[]) {
          deleteCalls += 1;
          if (deleteErr) return Promise.resolve({ count: null, error: deleteErr });
          const before = rows.length;
          rows = rows.filter((r) => !ids.includes(r.email_log_id));
          return Promise.resolve({ count: before - rows.length, error: null });
        },
      };
    },
    update() {
      return {
        in(_col: string, ids: string[]) {
          updateCalls += 1;
          if (updateErr) return Promise.resolve({ count: null, error: updateErr });
          let count = 0;
          outboxRows = outboxRows.map((row) => {
            if (!ids.includes(row.email_log_id)) return row;
            count += 1;
            return {
              ...row,
              provider_request_body: null,
              retry_content_snapshot: null,
            };
          });
          return Promise.resolve({ count, error: null });
        },
      };
    },
    insert(row: { cron_id: string }) {
      inserts.push(row.cron_id);
      return Promise.resolve({ error: null });
    },
  };
}

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: (table: string) => makeChain(table) }),
}));

async function runPurge(): Promise<{
  purged?: number;
  outbox_snapshots_purged?: number;
  skipped_for_staging?: boolean;
  capped?: boolean;
}> {
  vi.resetModules();
  const { emailRetryContentPurge } = await import("@/inngest/email-retry-content-purge");
  const fn = emailRetryContentPurge as unknown as {
    __handler: () => Promise<{
      purged?: number;
      outbox_snapshots_purged?: number;
      skipped_for_staging?: boolean;
      capped?: boolean;
    }>;
  };
  return fn.__handler();
}

// Mirror the module constants (email-retry-content-purge.ts).
const DELETE_BATCH = 1000;
const MAX_BATCHES = 20;
const expiredRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ email_log_id: `e${i}`, expires_at: daysAgo(1) }));

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  rows = [];
  outboxRows = [];
  selectErr = null;
  deleteErr = null;
  updateErr = null;
  deleteCalls = 0;
  updateCalls = 0;
  inserts.length = 0;
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("STAGING_MODE", "");
});

describe("email-retry-content-purge — §23.7 / #1611", () => {
  it("deletes expired rows and retains rows still inside their TTL", async () => {
    rows = [
      { email_log_id: "a", expires_at: daysAgo(1) }, // expired
      { email_log_id: "b", expires_at: daysAgo(3) }, // expired
      { email_log_id: "c", expires_at: daysAhead(2) }, // still live — must survive
    ];
    const result = await runPurge();
    expect(result.purged).toBe(2);
    expect(rows.map((r) => r.email_log_id)).toEqual(["c"]);
  });

  it("clears expired queued provider snapshots without touching live snapshots", async () => {
    outboxRows = [
      {
        email_log_id: "expired",
        provider_snapshot_expires_at: daysAgo(1),
        provider_request_body: JSON.stringify({ to: "expired@example.test" }),
        retry_content_snapshot: { html: "<p>expired</p>" },
      },
      {
        email_log_id: "live",
        provider_snapshot_expires_at: daysAhead(1),
        provider_request_body: JSON.stringify({ to: "live@example.test" }),
        retry_content_snapshot: { html: "<p>live</p>" },
      },
    ];

    const result = await runPurge();

    expect(result).toMatchObject({ outbox_snapshots_purged: 1 });
    expect(updateCalls).toBe(1);
    expect(outboxRows).toEqual([
      expect.objectContaining({
        email_log_id: "expired",
        provider_request_body: null,
        retry_content_snapshot: null,
      }),
      expect.objectContaining({
        email_log_id: "live",
        provider_request_body: expect.any(String),
      }),
    ]);
  });

  it("STAGING_MODE records the skip and returns early without deleting", async () => {
    vi.stubEnv("STAGING_MODE", "true");
    rows = [{ email_log_id: "a", expires_at: daysAgo(1) }]; // expired but must NOT be touched
    const result = await runPurge();
    expect(result).toEqual({ skipped_for_staging: true });
    expect(inserts).toEqual(["email-retry-content-purge"]);
    expect(rows.map((r) => r.email_log_id)).toEqual(["a"]); // untouched
  });

  it("throws (fail-loud) when the DELETE errors, so the run surfaces as failed", async () => {
    rows = [{ email_log_id: "a", expires_at: daysAgo(1) }];
    deleteErr = { message: "connection reset" };
    await expect(runPurge()).rejects.toThrow(/email_retry_content_purge_failed/);
  });

  it("throws (fail-loud) when the SELECT errors", async () => {
    rows = [{ email_log_id: "a", expires_at: daysAgo(1) }];
    selectErr = { message: "read timeout" };
    await expect(runPurge()).rejects.toThrow(/email_retry_content_purge_failed/);
  });

  it("throws when clearing an expired provider snapshot fails", async () => {
    outboxRows = [{
      email_log_id: "expired",
      provider_snapshot_expires_at: daysAgo(1),
      provider_request_body: "{}",
      retry_content_snapshot: null,
    }];
    updateErr = { message: "write timeout" };

    await expect(runPurge()).rejects.toThrow(/email_outbox_snapshot_purge_failed/);
  });

  it("loops across multiple batches (DELETE_BATCH+1 rows → two delete calls) without capping", async () => {
    // One row over a single batch: the first delete drains a full batch, the second
    // drains the remainder and comes back short → the loop exits normally, not capped.
    rows = expiredRows(DELETE_BATCH + 1);
    const result = await runPurge();
    expect(result.purged).toBe(DELETE_BATCH + 1);
    expect(result.capped).toBeUndefined();
    expect(deleteCalls).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it("flags capped:true (and warns) when the MAX_BATCHES bound is hit with backlog remaining", async () => {
    // More expired rows than one run can drain: every batch stays full, so the loop
    // exits on the bound with rows still past TTL. Operators alert on capped:true.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rows = expiredRows(MAX_BATCHES * DELETE_BATCH + 1);
    const result = await runPurge();
    expect(result.capped).toBe(true);
    expect(result.purged).toBe(MAX_BATCHES * DELETE_BATCH);
    expect(deleteCalls).toBe(MAX_BATCHES);
    expect(rows).toHaveLength(1); // backlog left for the next hourly run
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hit MAX_BATCHES"));
    warn.mockRestore();
  });
});
