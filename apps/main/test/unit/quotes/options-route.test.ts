// §38.3 / §21.10.1 — POST /api/quotes/:id/options.
//
// #1804: the #1742 price_kind/priced_at wiring only covered POST /api/quotes'
// single-option creation path. A quote built bare then priced entirely through
// this multi-option endpoint (§38's primary flow) never got its parent
// priced_at/price_kind stamped — quote-estimate-expiry-sweep's
// `.lt("priced_at", cutoff)` filter silently matched zero of these quotes
// (NULL < x is never true in SQL). This pins the fix: adding a priced option
// to a not-yet-priced quote stamps the parent; adding one to an already-priced
// quote leaves the existing priced_at freshness window untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantClient: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
    "@/lib/auth/assert-permission",
  );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({ tenantClient: mocks.tenantClient }));
vi.mock("@/lib/db/service-role-client", () => ({ createServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/quotes/tier-gate", () => ({ getMaxOptionsForTenant: vi.fn().mockResolvedValue(5) }));
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn().mockResolvedValue({ matched: false }),
}));

import { POST } from "@/app/api/quotes/[id]/options/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const QUOTE_ID = "99999999-8888-7777-6666-555555555555";

function makeDb(opts: {
  quotePricedAt: string | null;
  onQuoteUpdate: (payload: Record<string, unknown>) => void;
}) {
  return {
    from(table: string) {
      if (table === "quote_options") {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "opt-1", ...payload }, error: null }),
            }),
          }),
        };
      }
      if (table === "quotes") {
        const selectChain: Record<string, unknown> = {};
        selectChain.eq = () => selectChain;
        selectChain.single = () => Promise.resolve({ data: { priced_at: opts.quotePricedAt }, error: null });

        const updateChain: Record<string, unknown> = {};
        updateChain.eq = () => updateChain;
        updateChain.then = (resolve: (v: { data: null; error: null }) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve);

        return {
          select: () => selectChain,
          update: (payload: Record<string, unknown>) => {
            opts.onQuoteUpdate(payload);
            return updateChain;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function req(body: Record<string, unknown>): Request {
  return new Request(`https://tenant.example.com/api/quotes/${QUOTE_ID}/options`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertPermission.mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } },
    user: { id: "u1", auth_user_id: "auth-1", tenant_id: TENANT_ID, status: "active", role: "agent" },
  });
});

describe("POST /api/quotes/:id/options — price_kind evaluation (#1804)", () => {
  it("stamps the parent quote's priced_at/price_kind when a priced option is added to an unpriced quote", async () => {
    let updated: Record<string, unknown> = {};
    const db = makeDb({ quotePricedAt: null, onQuoteUpdate: (p) => { updated = p; } });
    mocks.tenantClient.mockReturnValue(db);

    const res = await POST(req({ total_amount_cents: 250000, cruise_line: "Royal" }), {
      params: Promise.resolve({ id: QUOTE_ID }),
    });

    expect(res.status).toBe(201);
    expect(updated.price_kind).toBe("estimate");
    expect(typeof updated.priced_at).toBe("string");
    expect(Number.isNaN(Date.parse(updated.priced_at as string))).toBe(false);
  });

  it("does not re-stamp a quote that already has priced_at", async () => {
    let updateCalled = false;
    const db = makeDb({ quotePricedAt: "2026-01-01T00:00:00.000Z", onQuoteUpdate: () => { updateCalled = true; } });
    mocks.tenantClient.mockReturnValue(db);

    const res = await POST(req({ total_amount_cents: 250000 }), {
      params: Promise.resolve({ id: QUOTE_ID }),
    });

    expect(res.status).toBe(201);
    expect(updateCalled).toBe(false);
  });

  it("leaves the parent quote untouched when the new option carries no price", async () => {
    let updateCalled = false;
    const db = makeDb({ quotePricedAt: null, onQuoteUpdate: () => { updateCalled = true; } });
    mocks.tenantClient.mockReturnValue(db);

    const res = await POST(req({ cruise_line: "Royal" }), {
      params: Promise.resolve({ id: QUOTE_ID }),
    });

    expect(res.status).toBe(201);
    expect(updateCalled).toBe(false);
  });
});
