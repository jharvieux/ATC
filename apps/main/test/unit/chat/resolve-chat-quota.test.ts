// #1015 — resolveChatQuota decision logic. These tests pin the SECURITY
// properties of the quota gate, not the limit-counter internals (those have
// their own suites): the admin bypass must be granted only on a positive
// platform_admins match (fail-closed on lookup error), each audience class
// must hit ITS limiter and no other, blocked decisions must carry the exact
// user-facing event (incl. §24.8's "never reveal which identifier hit"), and
// the customer hard-limit must leave an audit trail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveChatQuota } from "@/lib/chat/resolve-chat-quota";
import { enforceTaDailyLimit } from "@/lib/chat/ta-daily-limit";
import { enforceCustomerLimit, generateHardLimitSummary } from "@/lib/chat/customer-limit";
import {
  checkAnonLimit,
  incrementAnonCounters,
  recordLimitHitAndCheckBurst,
} from "@/lib/chat/anonymous-limit";
import { writeAuditLog } from "@/lib/audit/write";

vi.mock("@/lib/chat/ta-daily-limit", () => ({ enforceTaDailyLimit: vi.fn() }));
vi.mock("@/lib/chat/customer-limit", () => ({
  enforceCustomerLimit: vi.fn(),
  generateHardLimitSummary: vi.fn(async () => "summary"),
}));
vi.mock("@/lib/chat/anonymous-limit", () => ({
  checkAnonLimit: vi.fn(),
  incrementAnonCounters: vi.fn(async () => undefined),
  recordLimitHitAndCheckBurst: vi.fn(async () => undefined),
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: vi.fn(async () => undefined) }));
vi.mock("@/lib/chat/fingerprint", () => ({
  extractClientIp: vi.fn(() => "203.0.113.9"),
  deriveFingerprint: vi.fn(() => "fp-1"),
}));

function svcStub(opts: {
  adminRow?: unknown;
  adminError?: { message: string } | null;
} = {}) {
  const counterUpdates: unknown[] = [];
  const svc = {
    from(table: string) {
      if (table === "platform_admins") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.adminRow ?? null,
                error: opts.adminError ?? null,
              }),
            }),
          }),
        };
      }
      if (table === "customer_chat_counters") {
        return {
          update: (payload: unknown) => {
            counterUpdates.push(payload);
            const chain = {
              eq: () => chain,
              then: (resolve: (v: unknown) => void) =>
                resolve({ data: null, error: null }),
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { svc: svc as unknown as SupabaseClient, counterUpdates };
}

const req = new Request("https://example.test/api/chat", { method: "POST" });

function baseArgs(svc: SupabaseClient) {
  return {
    svc,
    req,
    tenantId: "tenant-1",
    audience: "customer" as const,
    userId: "users-1",
    authUserId: "auth-1",
    anonSessionId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("platform-admin bypass (#860)", () => {
  it("admin match → unmetered: allowed without consulting ANY limiter", async () => {
    const { svc } = svcStub({ adminRow: { auth_user_id: "auth-1" } });
    const d = await resolveChatQuota(baseArgs(svc));
    expect(d).toEqual({ allowed: true, personaAugmentation: null, customerCurrentCount: 0 });
    expect(enforceCustomerLimit).not.toHaveBeenCalled();
    expect(enforceTaDailyLimit).not.toHaveBeenCalled();
    expect(checkAnonLimit).not.toHaveBeenCalled();
  });

  it("lookup ERROR → fail-closed: no bypass, the customer limiter still runs", async () => {
    const { svc } = svcStub({ adminError: { message: "boom" } });
    vi.mocked(enforceCustomerLimit).mockResolvedValue({
      tier: "below",
      resolved: { soft1_cap: 20, soft2_cap: 30, hard_cap: 40, booking_bonus_percent: 0 },
      current_count: 3,
    });
    const d = await resolveChatQuota(baseArgs(svc));
    expect(enforceCustomerLimit).toHaveBeenCalledOnce();
    expect(d).toEqual({ allowed: true, personaAugmentation: null, customerCurrentCount: 3 });
  });

  it("no credential (anon) → platform_admins is never queried", async () => {
    const svc = {
      from(table: string) {
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;
    vi.mocked(checkAnonLimit).mockResolvedValue({ allowed: true });
    const d = await resolveChatQuota({
      ...baseArgs(svc),
      userId: null,
      authUserId: null,
      anonSessionId: "anon-1",
    });
    expect(d.allowed).toBe(true);
  });
});

describe("TA daily cap (#902)", () => {
  const taArgs = (svc: SupabaseClient) => ({
    ...baseArgs(svc),
    audience: "tenant_member" as const,
  });

  it("at cap → blocked with the cap message and a midnight-UTC reset", async () => {
    const { svc } = svcStub();
    vi.mocked(enforceTaDailyLimit).mockResolvedValue({
      allowed: false,
      current_count: 200,
      cap: 200,
      reason: "cap",
    });
    const d = await resolveChatQuota(taArgs(svc));
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.blockedResponse.type).toBe("hard_limit");
    expect(d.blockedResponse.body).toContain("200");
    if (d.blockedResponse.type !== "hard_limit") return;
    const reset = new Date(d.blockedResponse.reset_at);
    expect(reset.getUTCHours()).toBe(0);
    expect(reset.getTime()).toBeGreaterThan(Date.now());
  });

  it("count unavailable → still blocked (fail-closed), with the generic message", async () => {
    const { svc } = svcStub();
    vi.mocked(enforceTaDailyLimit).mockResolvedValue({
      allowed: false,
      current_count: 0,
      cap: 200,
      reason: "count_unavailable",
    });
    const d = await resolveChatQuota(taArgs(svc));
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.blockedResponse.body).toContain("temporarily unavailable");
  });

  it("under cap → allowed; live count flows out for message_count bookkeeping", async () => {
    const { svc } = svcStub();
    vi.mocked(enforceTaDailyLimit).mockResolvedValue({ allowed: true, current_count: 17, cap: 200 });
    const d = await resolveChatQuota(taArgs(svc));
    expect(d).toEqual({ allowed: true, personaAugmentation: null, customerCurrentCount: 17 });
    expect(enforceCustomerLimit).not.toHaveBeenCalled();
  });
});

describe("customer three-tier limit (§24.9)", () => {
  const resolved = { soft1_cap: 20, soft2_cap: 30, hard_cap: 40, booking_bonus_percent: 0 };

  it("hard tier → blocked, and the audit trail is written before returning", async () => {
    const { svc, counterUpdates } = svcStub();
    vi.mocked(enforceCustomerLimit).mockResolvedValue({
      tier: "hard",
      resolved,
      current_count: 40,
      reset_at: "2026-07-01T00:00:00.000Z",
    });
    const d = await resolveChatQuota(baseArgs(svc));
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.blockedResponse.type).toBe("hard_limit");
    if (d.blockedResponse.type !== "hard_limit") return;
    expect(d.blockedResponse.reset_at).toBe("2026-07-01T00:00:00.000Z");

    expect(generateHardLimitSummary).toHaveBeenCalledOnce();
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-1",
        action: "customer_chat.hard_limit_blocked",
        resource_id: "users-1",
      }),
    );
    // The counter row is re-linked to the audit entry just written.
    const auditArgs = vi.mocked(writeAuditLog).mock.calls[0]?.[0];
    const auditId = (auditArgs?.changes as { audit_correlation_id?: string } | undefined)
      ?.audit_correlation_id;
    expect(auditId).toBeTruthy();
    expect(counterUpdates).toEqual([{ hard_limit_summary_audit_id: auditId }]);
  });

  it.each(["soft1", "soft2"] as const)(
    "%s tier → allowed, with the in-character nudge surfaced for the prompt",
    async (tier) => {
      const { svc } = svcStub();
      vi.mocked(enforceCustomerLimit).mockResolvedValue({
        tier,
        resolved,
        current_count: 31,
        persona_augmentation: "gentle nudge",
      });
      const d = await resolveChatQuota(baseArgs(svc));
      expect(d).toEqual({ allowed: true, personaAugmentation: "gentle nudge", customerCurrentCount: 31 });
    },
  );

  it("below tier → allowed with no augmentation", async () => {
    const { svc } = svcStub();
    vi.mocked(enforceCustomerLimit).mockResolvedValue({
      tier: "below",
      resolved,
      current_count: 2,
    });
    const d = await resolveChatQuota(baseArgs(svc));
    expect(d).toEqual({ allowed: true, personaAugmentation: null, customerCurrentCount: 2 });
  });
});

describe("anonymous caps (§24.8)", () => {
  const anonArgs = (svc: SupabaseClient) => ({
    ...baseArgs(svc),
    userId: null,
    authUserId: null,
    anonSessionId: "anon-1",
  });

  it("over limit → signup wall that does NOT reveal which identifier hit; burst recorded; no increment", async () => {
    const { svc } = svcStub();
    vi.mocked(checkAnonLimit).mockResolvedValue({ allowed: false, hit_identifier_type: "ip" });
    const d = await resolveChatQuota(anonArgs(svc));
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.blockedResponse.type).toBe("signup_wall");
    expect(d.blockedResponse.body.toLowerCase()).not.toMatch(/\bip\b|fingerprint|session limit/);
    expect(recordLimitHitAndCheckBurst).toHaveBeenCalledWith(
      svc,
      expect.objectContaining({ hit_identifier_type: "ip", session_id: "anon-1" }),
    );
    expect(incrementAnonCounters).not.toHaveBeenCalled();
  });

  it("under limit → allowed, and the turn is counted against all three identifiers", async () => {
    const { svc } = svcStub();
    vi.mocked(checkAnonLimit).mockResolvedValue({ allowed: true });
    const d = await resolveChatQuota(anonArgs(svc));
    expect(d).toEqual({ allowed: true, personaAugmentation: null, customerCurrentCount: 0 });
    expect(incrementAnonCounters).toHaveBeenCalledWith(
      svc,
      expect.objectContaining({
        tenant_id: "tenant-1",
        session_id: "anon-1",
        ip: "203.0.113.9",
        fingerprint: "fp-1",
      }),
    );
  });
});
