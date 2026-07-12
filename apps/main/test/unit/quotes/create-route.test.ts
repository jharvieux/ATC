// §12.4 / §21.10.1 — POST /api/quotes (create).
//
// #1742: quotes.price_kind was never written by any code path — every quote
// sat at its DB DEFAULT 'estimate' forever, and resolveQuoteKind (the
// §21.10.1 CONFIRMED/ESTIMATE resolver) was called nowhere outside its own
// unit test. This pins the fix: a quote priced at creation (total_amount_cents
// supplied) gets price_kind evaluated + persisted via resolveQuoteKind, and
// priced_at stamped, rather than silently relying on the column default. A
// quote created WITHOUT a price is left unpriced (no priced_at) — there's
// nothing to evaluate yet.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  tenantClient: vi.fn(),
}));

vi.mock("@/lib/auth/assert-permission", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/assert-permission")>(
      "@/lib/auth/assert-permission",
    );
  return { ...actual, assertPermission: mocks.assertPermission };
});

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: mocks.tenantClient,
}));

// Non-fatal side effects the route performs after the insert — stub as
// successful no-ops so this file stays focused on the price_kind wiring.
vi.mock("@/lib/attribution/populate-conversion-touch", () => ({
  populateConversionTouch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn().mockResolvedValue({ matched: false }),
}));

import { POST } from "@/app/api/quotes/route";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

function makeDb(onQuoteInsert: (payload: Record<string, unknown>) => void) {
  return {
    from(table: string) {
      if (table === "quotes") {
        return {
          insert: (payload: Record<string, unknown>) => {
            onQuoteInsert(payload);
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: "quote-1", ...payload }, error: null }),
              }),
            };
          },
        };
      }
      // quote_options insert — irrelevant to this file's assertions.
      return {
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
  };
}

function req(body: Record<string, unknown>): Request {
  return new Request("https://tenant.example.com/api/quotes", {
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

describe("POST /api/quotes — price_kind evaluation at creation (#1742)", () => {
  it("stamps priced_at and evaluates price_kind='estimate' when a price is supplied", async () => {
    let inserted: Record<string, unknown> = {};
    const db = makeDb((payload) => {
      inserted = payload;
    });
    mocks.tenantClient.mockReturnValue(db);

    const res = await POST(
      req({ contact_id: "22222222-3333-4444-5555-666666666666", total_amount_cents: 250000, cruise_line: "Royal" }),
    );
    expect(res.status).toBe(201);
    // No price-lock write path exists yet (§21.10.1 default) — 'estimate' is
    // the only reachable outcome today, but it must be an EVALUATED write,
    // not silence that leaves it to the DB default.
    expect(inserted.price_kind).toBe("estimate");
    expect(typeof inserted.priced_at).toBe("string");
    expect(Number.isNaN(Date.parse(inserted.priced_at as string))).toBe(false);
  });

  it("leaves price_kind/priced_at unset when no price is supplied at creation", async () => {
    let inserted: Record<string, unknown> = {};
    const db = makeDb((payload) => {
      inserted = payload;
    });
    mocks.tenantClient.mockReturnValue(db);

    const res = await POST(req({ contact_id: "22222222-3333-4444-5555-666666666666" }));
    expect(res.status).toBe(201);
    expect(inserted.price_kind).toBeUndefined();
    expect(inserted.priced_at).toBeUndefined();
  });
});
