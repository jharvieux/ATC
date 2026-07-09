// Issue #700 — Pin the carve-outs that make this sweep safe to run AND
// the SQL filter shape that makes those carve-outs actually fire.
//
// Invariants the cron MUST hold (each test fails if it regresses):
//   1. The SELECT filter chain composes the right (column, value) pairs
//      for the carve-outs — anything else and protected tenants get
//      caught by the sweep. The first audit caught the PostgREST `not in`
//      quoting bug by reading the source; this test captures the
//      argument shapes so a future regression can't slip past review.
//   2. is_platform_internal=true rows are excluded from the SELECT.
//   3. onboarding_stage IN ('review_submitted', 'complete') rows are
//      excluded.
//   4. The status UPDATE is CAS-guarded (.eq("status", "onboarding") on
//      the update) so a tenant that finished onboarding between SELECT
//      and UPDATE is NOT suspended.
//   5. The audit_log INSERT only fires when the CAS actually transitioned
//      the row (length === 1).
//   6. A DB error on the SELECT throws (so Inngest auto-retries) rather
//      than returning {ok:false} silently.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Match the codebase convention from quote-estimate-expiry-sweep.test.ts:
// override createFunction so the test can invoke the handler directly.
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_: unknown, handler: unknown) => ({ __handler: handler }),
  },
}));

// Capture the filter call sequence on the SELECT chain so we can assert
// the PostgREST argument shape (the bug-catching part of this test).
const capturedSelectCalls: Array<{ method: string; args: unknown[] }> = [];
const capturedUpdateCalls: Array<{ method: string; args: unknown[] }> = [];
let selectResult: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null };
const updateResults: Array<{ data: { id: string }[] | null; error: { message: string } | null }> = [];

// #1607 — the audit_log INSERT now goes through the canonical writeAuditLog
// helper rather than a direct `.from("audit_log").insert(...)` on the
// platform-admin db, so it's mocked at the module level instead of via the
// fake `db` below.
let auditWriteShouldThrow = false;
const auditInsertSpy = vi.fn(async (_row: unknown, _opts?: { throwOnError?: boolean }) => {
  if (auditWriteShouldThrow) {
    throw new Error("audit_log insert failed [tenant.auto_suspended_stale_onboarding]: connection refused");
  }
});
vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: auditInsertSpy,
}));

function makeSelectChain(): Record<string, (...a: unknown[]) => unknown> {
  const chain: Record<string, (...a: unknown[]) => unknown> = {
    select(...args: unknown[]) {
      capturedSelectCalls.push({ method: "select", args });
      return chain;
    },
    eq(...args: unknown[]) {
      capturedSelectCalls.push({ method: "eq", args });
      return chain;
    },
    lt(...args: unknown[]) {
      capturedSelectCalls.push({ method: "lt", args });
      return chain;
    },
    not(...args: unknown[]) {
      capturedSelectCalls.push({ method: "not", args });
      return chain;
    },
    limit(...args: unknown[]) {
      capturedSelectCalls.push({ method: "limit", args });
      return Promise.resolve(selectResult);
    },
  };
  return chain;
}

function makeUpdateChain(): Record<string, (...a: unknown[]) => unknown> {
  const chain: Record<string, (...a: unknown[]) => unknown> = {
    eq(...args: unknown[]) {
      capturedUpdateCalls.push({ method: "eq", args });
      return chain;
    },
    select(...args: unknown[]) {
      capturedUpdateCalls.push({ method: "select", args });
      const result = updateResults.shift() ?? { data: [], error: null };
      return Promise.resolve(result);
    },
  };
  return chain;
}

// Isolate the RAG shadow emit (it runs its own tenants update; mocking it
// keeps the update-call count assertions about the cron's own writes).
const shadowEmitMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/rag-sync/publish-tenant-shadow-event", () => ({
  publishTenantShadowEvent: shadowEmitMock,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(
    async (
      _opts: unknown,
      fn: (db: unknown, recordQuery: () => void) => Promise<unknown>,
    ) => {
      const db = {
        from(table: string) {
          if (table === "tenants") {
            return {
              ...makeSelectChain(),
              update(payload: unknown) {
                capturedUpdateCalls.push({ method: "update", args: [payload] });
                return makeUpdateChain();
              },
            };
          }
          throw new Error(`unexpected table: ${table}`);
        },
      };
      return fn(db, () => undefined);
    },
  ),
}));

beforeEach(() => {
  capturedSelectCalls.length = 0;
  capturedUpdateCalls.length = 0;
  updateResults.length = 0;
  selectResult = { data: [], error: null };
  auditInsertSpy.mockClear();
  auditWriteShouldThrow = false;
});

async function runHandler(): Promise<unknown> {
  const mod = (await import("@/inngest/onboarding-stale-suspend")) as unknown as {
    onboardingStaleSuspend: { __handler: () => Promise<unknown> };
  };
  return mod.onboardingStaleSuspend.__handler();
}

describe("onboardingStaleSuspend — SELECT filter shape", () => {
  it("filters status='onboarding'", async () => {
    await runHandler();
    const eqCalls = capturedSelectCalls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["status", "onboarding"] });
  });

  it("excludes is_platform_internal=true rows via .eq('is_platform_internal', false) (#699)", async () => {
    await runHandler();
    const eqCalls = capturedSelectCalls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["is_platform_internal", false] });
  });

  it("uses bare comma-separated tokens in the .not('onboarding_stage', 'in', ...) value, NOT quoted (#700 first-audit bug)", async () => {
    // The bug: building the value as `("a","b")` matches strings that
    // contain the quote characters, so neither carve-out fires and
    // review_submitted/complete tenants get suspended.
    await runHandler();
    const notCall = capturedSelectCalls.find((c) => c.method === "not");
    expect(notCall).toBeDefined();
    expect(notCall?.args[0]).toBe("onboarding_stage");
    expect(notCall?.args[1]).toBe("in");
    const value = notCall?.args[2] as string;
    expect(value).toBe("(review_submitted,complete)");
    expect(value).not.toContain('"');
  });

  it("applies created_at < cutoff via .lt('created_at', ...)", async () => {
    await runHandler();
    const ltCall = capturedSelectCalls.find((c) => c.method === "lt");
    expect(ltCall).toBeDefined();
    expect(ltCall?.args[0]).toBe("created_at");
    // 14-day-ago ISO timestamp. Sanity-check by parsing.
    const cutoffIso = ltCall?.args[1] as string;
    const cutoffMs = new Date(cutoffIso).getTime();
    expect(Number.isNaN(cutoffMs)).toBe(false);
    expect(Date.now() - cutoffMs).toBeGreaterThan(13.5 * 24 * 60 * 60 * 1000);
    expect(Date.now() - cutoffMs).toBeLessThan(14.5 * 24 * 60 * 60 * 1000);
  });
});

describe("onboardingStaleSuspend — CAS guard + audit gating", () => {
  it("CAS-guards the UPDATE with .eq('status', 'onboarding') and only audits the rows that actually transitioned", async () => {
    selectResult = {
      data: [
        { id: "t-stuck-1", slug: "abandoned-co", onboarding_stage: "legal", created_at: "2026-04-01T00:00:00Z" },
        { id: "t-stuck-2", slug: "abandoned-co-2", onboarding_stage: "tier_select", created_at: "2026-04-01T00:00:00Z" },
      ],
      error: null,
    };
    updateResults.push({ data: [{ id: "t-stuck-1" }], error: null });
    // CAS lost on the second tenant — finished onboarding between SELECT and UPDATE.
    updateResults.push({ data: [], error: null });

    const result = await runHandler();
    expect(result).toMatchObject({ ok: true, candidates: 2, suspended: 1 });

    // Both rows attempted: 2 updates and 2 .select("id") chains.
    expect(capturedUpdateCalls.filter((c) => c.method === "update")).toHaveLength(2);
    expect(capturedUpdateCalls.filter((c) => c.method === "select")).toHaveLength(2);
    // Status filter present on every update.
    const statusEqs = capturedUpdateCalls.filter(
      (c) => c.method === "eq" && c.args[0] === "status",
    );
    expect(statusEqs).toHaveLength(2);
    statusEqs.forEach((c) => expect(c.args[1]).toBe("onboarding"));

    // Audit fires ONLY for the row that actually transitioned.
    expect(auditInsertSpy).toHaveBeenCalledTimes(1);
    // ...and that same row is announced to RAG so retrieval is cut off.
    expect(shadowEmitMock).toHaveBeenCalledTimes(1);
    expect(shadowEmitMock).toHaveBeenCalledWith(expect.anything(), "t-stuck-1", "tenant.status_changed");
    const auditPayload = auditInsertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditPayload.tenant_id).toBe("t-stuck-1");
    expect(auditPayload.action).toBe("tenant.auto_suspended_stale_onboarding");
    expect(auditPayload.actor_type).toBe("system");
    expect(auditPayload.actor_user_id).toBeNull();
    expect(auditPayload.resource_type).toBe("tenant");
    expect(auditPayload.resource_id).toBe("t-stuck-1");
    // Slug landed in the audit `changes` JSONB (was previously only in
    // the console.info log — pre-pr audit W3).
    expect((auditPayload.changes as Record<string, unknown>).slug).toBe("abandoned-co");
    // #1607 — requests throwOnError so a failed audit write still fails the
    // run for retry, matching the pre-migration safeAwait-throws behavior.
    expect(auditInsertSpy.mock.calls[0]?.[1]).toMatchObject({ throwOnError: true });
  });

  it("throws on UPDATE error so Inngest auto-retries (does NOT silently skip the tenant)", async () => {
    selectResult = {
      data: [{ id: "t-stuck-3", slug: "x", onboarding_stage: "legal", created_at: "2026-04-01T00:00:00Z" }],
      error: null,
    };
    updateResults.push({
      data: null,
      error: { message: "connection refused" },
    });

    await expect(runHandler()).rejects.toThrow(/connection refused/);
    expect(auditInsertSpy).not.toHaveBeenCalled();
  });

  // #1607 — pins the throwOnError:true contract: a failed audit_log write
  // for an automated tenant suspension must still fail the Inngest run
  // (visible, retryable) rather than being silently swallowed the way
  // writeAuditLog behaves for its other 47+ non-cron call sites.
  it("throws when the audit write itself fails so Inngest retries", async () => {
    selectResult = {
      data: [{ id: "t-stuck-4", slug: "y", onboarding_stage: "legal", created_at: "2026-04-01T00:00:00Z" }],
      error: null,
    };
    updateResults.push({ data: [{ id: "t-stuck-4" }], error: null });
    auditWriteShouldThrow = true;

    await expect(runHandler()).rejects.toThrow(/audit_log insert failed/);
  });
});

describe("onboardingStaleSuspend — DB error throws for retry", () => {
  it("throws on SELECT error so Inngest retries instead of silently marking 'success'", async () => {
    selectResult = { data: null, error: { message: "connection refused" } };
    // Pre-pr W2: if this returned {ok:false} instead, Inngest would skip
    // retry and the abuse keeps running until the next firing.
    await expect(runHandler()).rejects.toThrow(/connection refused/);
    expect(capturedUpdateCalls).toHaveLength(0);
    expect(auditInsertSpy).not.toHaveBeenCalled();
  });
});
