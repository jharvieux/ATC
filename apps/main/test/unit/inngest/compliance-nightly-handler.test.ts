// #1928 — handler-level coverage for compliance-nightly's ICA-drift branch
// and the already_sent / no_activity_data guards.
//
// Context: PR #1925 fixed a bug where the cron SELECTed a column from the
// wrong table, tripping a bare `return` and silently killing every 30/60/90-day
// inactivity reminder every night. It survived because the only pre-existing
// test covered a pure helper (selectNudgeLevel) — nothing exercised the cron
// handler's actual data access. These tests close that gap for the paths that
// are the same shape as the bug that shipped: data-access branches inside a
// cron whose errors nobody sees.
//
// Also pins the #1933 (unbounded SELECT truncation) and #1934 (nudge row
// ordering) fixes at the handler level, per those issues' acceptance criteria.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendEmail = vi.fn();
vi.mock("@/lib/email/send", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  TENANT_BRANDING_COLUMNS:
    "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
    "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
    "email_from_name, email_from_domain, email_from_domain_verified_at",
}));

// Every table call is recorded here (table, method, args) so assertions can
// inspect exactly what the handler sent to the DB, independent of the mock's
// own internal per-table branching.
let allCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
const mockFrom = vi.fn();
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: (table: string) => mockFrom(table) }),
}));

type Resolved = { data: unknown; error: { message: string } | null };

// Generic chainable mock: records every method call (select/eq/in/order/
// range/maybeSingle/insert/update/...) and resolves whatever `resolve` computes
// from the accumulated call list when the chain is finally awaited. This is
// what lets a single mock support both the simple call shapes (most tables)
// and the range-aware pagination shape the #1933 fix needs to be tested at all.
function makeChain(table: string, resolve: (calls: Array<{ method: string; args: unknown[] }>) => Resolved) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "then") {
          const p = Promise.resolve(resolve(calls));
          return p.then.bind(p);
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          allCalls.push({ table, method: prop, args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

function rangeSlice<T>(calls: Array<{ method: string; args: unknown[] }>, all: T[]): T[] {
  const rangeCall = [...calls].reverse().find((c) => c.method === "range");
  if (!rangeCall) return all;
  const [from, to] = rangeCall.args as [number, number];
  return all.slice(from, to + 1);
}

const TENANT_BASE = {
  status: "active",
  legal_name: "Test Agency",
  display_name: "Test Agency",
  mailing_address: null,
  subscription_status: "active",
  non_paying_since: null,
  is_platform_internal: false,
};

const OLD_ISO = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40d idle → trips 30d

async function runCron(): Promise<Record<string, unknown>> {
  const { complianceNightly } = await import("@/inngest/compliance-nightly");
  return (complianceNightly as unknown as { fn: () => Promise<Record<string, unknown>> }).fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  allCalls = [];
  mockSendEmail.mockResolvedValue({ status: "sent" });
});

describe("compliance-nightly — ICA version drift (#1928)", () => {
  it("flags a tenant whose accepted ICA version is behind the latest published version", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") {
        return makeChain(table, () => ({ data: [{ version: 3 }], error: null }));
      }
      if (table === "tenants") {
        return makeChain(table, (calls) => {
          const selectArg = calls.find((c) => c.method === "select")?.args[0] as string | undefined;
          // The ICA-drift SELECT asks only for `id`; the main handler's
          // active-tenants SELECT asks for the full contact projection.
          // Distinguishing lets one mock stand in for both queries on the
          // same table without conflating their result sets.
          if (selectArg === "id") return { data: [{ id: "t-drift" }], error: null };
          if (calls.some((c) => c.method === "update")) return { data: null, error: null };
          // Main handler's tenant list is empty — this test isolates the
          // ICA-drift branch from the inactivity-nudge branch.
          return { data: [], error: null };
        });
      }
      if (table === "legal_consents") {
        // Accepted version 1 < latest 3 → drift.
        return makeChain(table, () => ({ data: [{ document_version: 1 }], error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(result.ica_reacceptance_flagged).toBe(1);
    const update = allCalls.find((c) => c.table === "tenants" && c.method === "update");
    expect(update).toBeDefined();
    expect(update!.args[0]).toEqual({ requires_ica_reacceptance: true });
  });

  it("does not flag a tenant whose accepted version already matches latest", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") {
        return makeChain(table, () => ({ data: [{ version: 3 }], error: null }));
      }
      if (table === "tenants") {
        return makeChain(table, (calls) => {
          const selectArg = calls.find((c) => c.method === "select")?.args[0] as string | undefined;
          if (selectArg === "id") return { data: [{ id: "t-current" }], error: null };
          return { data: [], error: null };
        });
      }
      if (table === "legal_consents") {
        return makeChain(table, () => ({ data: [{ document_version: 3 }], error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(result.ica_reacceptance_flagged).toBe(0);
    expect(allCalls.find((c) => c.table === "tenants" && c.method === "update")).toBeUndefined();
  });
});

describe("compliance-nightly — already_sent guard (#1928)", () => {
  it("skips a tenant that already has a nudge row for the tripped level — no email, no re-insert", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, () => ({
          data: [{ id: "t1", support_email: "owner@tenant.com", ...TENANT_BASE }],
          error: null,
        }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [{ created_at: OLD_ISO }], error: null }));
      }
      if (table === "tenant_inactivity_nudges") {
        // maybeSingle finds an existing row for this tenant/level.
        return makeChain(table, () => ({ data: { id: "existing-nudge" }, error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(result.reminders_sent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // The already_sent guard must short-circuit BEFORE any insert — a second
    // insert here would mean the dedup check stopped gating re-sends.
    expect(allCalls.find((c) => c.table === "tenant_inactivity_nudges" && c.method === "insert")).toBeUndefined();
  });
});

describe("compliance-nightly — no_activity_data guard (#1928)", () => {
  it("skips a tenant with no conversations/bookings ever recorded — no nudge lookup, no email", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, () => ({
          data: [{ id: "t1", support_email: "owner@tenant.com", ...TENANT_BASE }],
          error: null,
        }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [], error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(result.reminders_sent).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    // A freshly-approved tenant with zero activity must never reach the
    // nudge-dedup lookup — there's no level to dedup against yet.
    expect(allCalls.find((c) => c.table === "tenant_inactivity_nudges")).toBeUndefined();
  });

  it("throws on a conversations select error instead of misclassifying the tenant as no_activity_data", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, () => ({
          data: [{ id: "t1", support_email: "owner@tenant.com", ...TENANT_BASE }],
          error: null,
        }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations") {
        return makeChain(table, () => ({ data: null, error: { message: "connection reset" } }));
      }
      if (table === "bookings") return makeChain(table, () => ({ data: [], error: null }));
      return makeChain(table, () => ({ data: [], error: null }));
    });

    // A transient DB error on the activity lookup must retry via Inngest, not
    // silently fall through to "no_activity_data" (which would mean the
    // tenant never gets nudged and nobody notices).
    await expect(runCron()).rejects.toThrow(/conversations\.select failed/);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(allCalls.find((c) => c.table === "tenant_inactivity_nudges")).toBeUndefined();
  });
});

describe("compliance-nightly — #1933 bounded tenants/branding reads", () => {
  it("resolves branding for a tenant past the 1000-row PostgREST cap instead of falling back to null", async () => {
    const TOTAL = 1500;
    const bigTenants = Array.from({ length: TOTAL }, (_, i) => ({
      id: `t${i}`,
      support_email: i === TOTAL - 1 ? "last@tenant.com" : null,
      ...TENANT_BASE,
    }));
    const bigBranding = Array.from({ length: TOTAL }, (_, i) => ({
      tenant_id: `t${i}`,
      email_send_pattern: "tenant_resend",
      tenant_resend_api_key_encrypted: "enc-key",
      email_from_address: `custom-t${i}@tenant.com`,
      email_from_name: "Custom",
      email_from_domain: null,
      email_from_domain_verified_at: null,
    }));

    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, (calls) => ({ data: rangeSlice(calls, bigTenants), error: null }));
      }
      if (table === "tenant_branding") {
        return makeChain(table, (calls) => ({ data: rangeSlice(calls, bigBranding), error: null }));
      }
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [{ created_at: OLD_ISO }], error: null }));
      }
      if (table === "tenant_inactivity_nudges") {
        // maybeSingle expects a single row or null, never `[]` — an empty
        // array is truthy in JS and would trip the already_sent guard for
        // every tenant, masking the assertion this test exists to make.
        return makeChain(table, () => ({ data: null, error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    await runCron();

    // The 1500th tenant sits ~500 rows past PostgREST's default 1000-row cap.
    // Before the #1933 fix, its branding row would be silently dropped and
    // email_from_address would coalesce to null (platform domain). If
    // pagination regresses, this assertion fails.
    const lastTenantSend = mockSendEmail.mock.calls.find(
      (call) => (call[0] as { tenant: { id: string } }).tenant.id === `t${TOTAL - 1}`,
    );
    expect(lastTenantSend).toBeDefined();
    const tenantArg = (lastTenantSend![0] as { tenant: Record<string, unknown> }).tenant;
    expect(tenantArg.email_from_address).toBe(`custom-t${TOTAL - 1}@tenant.com`);
  });

  it("terminates cleanly when the tenant count is an exact multiple of the page size — no dropped or duplicated page", async () => {
    // PAGE is 1000; 2000 rows means the pagination loop's final .range() call
    // returns a full page (length === PAGE), so the loop must make one more
    // request that comes back empty to know to stop. A boundary bug here
    // either drops the last page (batch.length < PAGE never true) or spins
    // forever re-requesting the same full page.
    const TOTAL = 2000;
    const bigTenants = Array.from({ length: TOTAL }, (_, i) => ({
      id: `t${i}`,
      support_email: i === TOTAL - 1 ? "last@tenant.com" : null,
      ...TENANT_BASE,
    }));

    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, (calls) => ({ data: rangeSlice(calls, bigTenants), error: null }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [{ created_at: OLD_ISO }], error: null }));
      }
      if (table === "tenant_inactivity_nudges") {
        return makeChain(table, () => ({ data: null, error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    // Every one of the 2000 tenants must be processed exactly once: not 1999
    // (last page dropped) and not more (last page re-fetched and duplicated).
    expect(result.tenants_processed).toBe(TOTAL);
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});

describe("compliance-nightly — #1934 nudge row written after send, not before", () => {
  it("does not record the nudge when the send fails — the level stays retryable next run", async () => {
    mockSendEmail.mockResolvedValue({ status: "failed", reason: "resend_500" });
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, () => ({
          data: [{ id: "t1", support_email: "owner@tenant.com", ...TENANT_BASE }],
          error: null,
        }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [{ created_at: OLD_ISO }], error: null }));
      }
      if (table === "tenant_inactivity_nudges") {
        return makeChain(table, () => ({ data: null, error: null })); // no existing nudge
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(result.reminders_sent).toBe(0);
    // The bug this pins: a failed send used to leave the nudge row in place
    // anyway, which permanently suppressed the retry via the already_sent
    // guard. No insert here means the next nightly run will try again.
    expect(allCalls.find((c) => c.table === "tenant_inactivity_nudges" && c.method === "insert")).toBeUndefined();
  });

  it("records the nudge only after a confirmed send", async () => {
    mockSendEmail.mockResolvedValue({ status: "sent" });
    mockFrom.mockImplementation((table: string) => {
      if (table === "legal_documents") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "tenants") {
        return makeChain(table, () => ({
          data: [{ id: "t1", support_email: "owner@tenant.com", ...TENANT_BASE }],
          error: null,
        }));
      }
      if (table === "tenant_branding") return makeChain(table, () => ({ data: [], error: null }));
      if (table === "conversations" || table === "bookings") {
        return makeChain(table, () => ({ data: [{ created_at: OLD_ISO }], error: null }));
      }
      if (table === "tenant_inactivity_nudges") {
        return makeChain(table, () => ({ data: null, error: null }));
      }
      return makeChain(table, () => ({ data: [], error: null }));
    });

    const result = await runCron();

    expect(result.reminders_sent).toBe(1);
    const insert = allCalls.find((c) => c.table === "tenant_inactivity_nudges" && c.method === "insert");
    expect(insert).toBeDefined();
    expect((insert!.args[0] as { tenant_id: string; nudge_level: string }).tenant_id).toBe("t1");
  });
});
