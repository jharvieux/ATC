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
let rows: Row[];
let selectErr: { message: string } | null;
let deleteErr: { message: string } | null;
const inserts: string[] = [];

function makeChain() {
  return {
    select() {
      let cutoff = "";
      const chain = {
        lt(_col: string, c: string) {
          cutoff = c;
          return chain;
        },
        limit(n: number) {
          if (selectErr) return Promise.resolve({ data: null, error: selectErr });
          const matched = rows.filter((r) => r.expires_at < cutoff).slice(0, n);
          return Promise.resolve({ data: matched.map((r) => ({ email_log_id: r.email_log_id })), error: null });
        },
      };
      return chain;
    },
    delete() {
      return {
        in(_col: string, ids: string[]) {
          if (deleteErr) return Promise.resolve({ count: null, error: deleteErr });
          const before = rows.length;
          rows = rows.filter((r) => !ids.includes(r.email_log_id));
          return Promise.resolve({ count: before - rows.length, error: null });
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
  createServiceRoleClient: () => ({ from: (_t: string) => makeChain() }),
}));

async function runPurge(): Promise<{ purged?: number; skipped_for_staging?: boolean }> {
  vi.resetModules();
  const { emailRetryContentPurge } = await import("@/inngest/email-retry-content-purge");
  const fn = emailRetryContentPurge as unknown as {
    __handler: () => Promise<{ purged?: number; skipped_for_staging?: boolean }>;
  };
  return fn.__handler();
}

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  rows = [];
  selectErr = null;
  deleteErr = null;
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
});
