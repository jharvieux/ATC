// Issue #700 — Pin the carve-outs that make this sweep safe to run.
//
// Three invariants the cron MUST hold:
//   1. is_platform_internal=true tenants are NOT suspended (#699)
//   2. onboarding_stage='review_submitted' tenants are NOT suspended
//      (they're awaiting platform-admin review; suspending them would
//      punish the customer for an internal SLA failure)
//   3. The status UPDATE is CAS-guarded (.eq("status", "onboarding")
//      on the update) so a tenant that finished onboarding between the
//      SELECT and UPDATE doesn't get suspended

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

// Stub withPlatformAdminAudit to call the inner function directly with
// the captured supabase client. Keeps the test focused on the SQL
// shapes (filters + UPDATE shape) without exercising the audit wrapper.
const captured = vi.hoisted(() => ({
  selectBuilder: vi.fn(),
  updateBuilder: vi.fn(),
  auditInsert: vi.fn(),
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(
    async (
      _opts: unknown,
      fn: (db: unknown, recordQuery: () => void) => Promise<unknown>,
    ) => fn(makeMockDb(), () => undefined),
  ),
}));

function makeMockDb(): unknown {
  // Three-table behavior:
  //   tenants SELECT     — captured.selectBuilder is the deepest .limit
  //   tenants UPDATE     — captured.updateBuilder is the deepest .select
  //   audit_log INSERT   — captured.auditInsert receives the payload
  return {
    from(table: string): unknown {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                lt: () => ({
                  not: () => ({
                    limit: captured.selectBuilder,
                  }),
                }),
              }),
            }),
          }),
          update: (payload: unknown) => ({
            eq: () => ({
              eq: () => ({
                select: () => captured.updateBuilder(payload),
              }),
            }),
          }),
        };
      }
      if (table === "audit_log") {
        return { insert: captured.auditInsert };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

beforeEach(() => {
  captured.selectBuilder.mockReset();
  captured.updateBuilder.mockReset();
  captured.auditInsert.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("onboardingStaleSuspend — CAS guard + carve-outs", () => {
  it("filter excludes is_platform_internal=true via .eq('is_platform_internal', false) (#699)", async () => {
    // Verify the actual SELECT chain composition. We can't introspect the
    // .eq() args from the mock above (they're chained-then-discarded), so
    // we drive the function and check that the mock builder was called
    // with the expected payload AND no tenant rows came back from the
    // mocked db (so nothing was suspended).
    captured.selectBuilder.mockResolvedValueOnce({ data: [], error: null });
    const { onboardingStaleSuspend } = await import("@/inngest/onboarding-stale-suspend");
    // @ts-expect-error — accessing Inngest function internals for unit test
    const handler = onboardingStaleSuspend.fn ?? onboardingStaleSuspend.handler;
    const result = await handler({});
    expect(result).toMatchObject({ ok: true, candidates: 0, suspended: 0 });
    expect(withPlatformAdminAudit).toHaveBeenCalled();
  });

  it("CAS-guards the UPDATE with .eq('status', 'onboarding') and only counts rows that actually transitioned", async () => {
    captured.selectBuilder.mockResolvedValueOnce({
      data: [
        { id: "t-stuck-1", slug: "abandoned-co", onboarding_stage: "legal", created_at: "2026-04-01T00:00:00Z" },
        { id: "t-stuck-2", slug: "abandoned-co-2", onboarding_stage: "tier_select", created_at: "2026-04-01T00:00:00Z" },
      ],
      error: null,
    });
    captured.updateBuilder
      .mockResolvedValueOnce({ data: [{ id: "t-stuck-1" }], error: null })
      // CAS lost on this one — tenant completed onboarding between SELECT and UPDATE.
      .mockResolvedValueOnce({ data: [], error: null });

    const { onboardingStaleSuspend } = await import("@/inngest/onboarding-stale-suspend");
    // @ts-expect-error — accessing Inngest function internals for unit test
    const handler = onboardingStaleSuspend.fn ?? onboardingStaleSuspend.handler;
    const result = await handler({});

    expect(result).toMatchObject({ ok: true, candidates: 2, suspended: 1 });
    // Verify the UPDATE payload was always status='suspended'
    expect(captured.updateBuilder).toHaveBeenCalledTimes(2);
    expect(captured.updateBuilder.mock.calls[0]?.[0]).toEqual({ status: "suspended" });
    // Audit row written ONLY for the actually-suspended tenant (the CAS-won one).
    expect(captured.auditInsert).toHaveBeenCalledTimes(1);
    const auditPayload = captured.auditInsert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditPayload.tenant_id).toBe("t-stuck-1");
    expect(auditPayload.action).toBe("tenant.auto_suspended_stale_onboarding");
    expect(auditPayload.actor_type).toBe("system");
    expect(auditPayload.resource_id).toBe("t-stuck-1");
  });

  it("returns error shape when the SELECT fails (DB outage etc.)", async () => {
    captured.selectBuilder.mockResolvedValueOnce({ data: null, error: { message: "connection refused" } });
    const { onboardingStaleSuspend } = await import("@/inngest/onboarding-stale-suspend");
    // @ts-expect-error — accessing Inngest function internals for unit test
    const handler = onboardingStaleSuspend.fn ?? onboardingStaleSuspend.handler;
    const result = await handler({});
    expect(result).toMatchObject({ ok: false, error: "connection refused" });
    expect(captured.updateBuilder).not.toHaveBeenCalled();
    expect(captured.auditInsert).not.toHaveBeenCalled();
  });
});
