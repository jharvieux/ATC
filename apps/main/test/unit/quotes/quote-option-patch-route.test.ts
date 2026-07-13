// §38 / §21.10.1 — PATCH /api/quote-options/:id.
//
// #1804: re-pricing an option (total_amount_cents changes) must re-stamp the
// parent quote's priced_at/price_kind, mirroring the POST
// /api/quotes/:id/options wiring — otherwise a quote priced through this
// endpoint never has quote-estimate-expiry-sweep's `.lt("priced_at", cutoff)`
// filter match it. Unlike option creation, a re-price always re-stamps: the
// §21.10.1 freshness window tracks the most recent pricing action.

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
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn().mockResolvedValue({ matched: false }),
}));

import { PATCH } from "@/app/api/quote-options/[id]/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const OPTION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const QUOTE_ID = "99999999-8888-7777-6666-555555555555";

function makeDb(onQuoteUpdate: (payload: Record<string, unknown>) => void) {
  return {
    from(table: string) {
      if (table === "quote_options") {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: OPTION_ID, quote_id: QUOTE_ID, ...payload }, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "quotes") {
        return {
          update: (payload: Record<string, unknown>) => {
            onQuoteUpdate(payload);
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function req(body: Record<string, unknown>): Request {
  return new Request(`https://tenant.example.com/api/quote-options/${OPTION_ID}`, {
    method: "PATCH",
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

describe("PATCH /api/quote-options/:id — re-stamps parent quote price_kind (#1804)", () => {
  it("re-stamps the parent quote's priced_at/price_kind when total_amount_cents changes", async () => {
    let updated: Record<string, unknown> = {};
    const db = makeDb((p) => { updated = p; });
    mocks.tenantClient.mockReturnValue(db);

    const res = await PATCH(req({ total_amount_cents: 300000 }), {
      params: Promise.resolve({ id: OPTION_ID }),
    });

    expect(res.status).toBe(200);
    expect(updated.price_kind).toBe("estimate");
    expect(typeof updated.priced_at).toBe("string");
    expect(Number.isNaN(Date.parse(updated.priced_at as string))).toBe(false);
  });

  it("leaves the parent quote untouched when the patch doesn't touch pricing", async () => {
    let updateCalled = false;
    const db = makeDb(() => { updateCalled = true; });
    mocks.tenantClient.mockReturnValue(db);

    const res = await PATCH(req({ cabin_category: "Balcony" }), {
      params: Promise.resolve({ id: OPTION_ID }),
    });

    expect(res.status).toBe(200);
    expect(updateCalled).toBe(false);
  });
});
