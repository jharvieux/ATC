// §12.4 / §21.10.1 — loadQuoteRenderInput (#451).
//
// Contracts pinned here:
//   1. Kind selection: a quote with a locked_price_cents lands as
//      "confirmed"; otherwise "estimate". The renderer's banner copy and
//      footer disclosure key off this — getting it wrong sends the wrong
//      legal disclosure on the customer attachment.
//   2. Total-cents source-of-truth fallback: locked → estimate → total*100.
//   3. host_agency_legal_name shape tolerance: platform_settings.value
//      can be a string OR a JSON object with a `.value` field. The send
//      route shipped with both forms in the wild.
//   4. Failure modes surface as a structured non-ok result with HTTP
//      status — both the agent download and the customer send rely on
//      the helper to fail loud instead of silently rendering with bad
//      data.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadQuoteRenderInput } from "@/lib/quotes/build-render-input";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const CTX: TenantContext = {
  tenant_id: TENANT_ID,
  source: { kind: "http_request", user_id: "user-1" },
};

interface QuoteData {
  id: string;
  status: string;
  customer_access_token: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  total_amount: number | null;
  locked_price_cents: number | null;
  estimate_price_cents: number | null;
  price_lock_expires_at: string | null;
  priced_at: string | null;
}

function makeDb(quote: { data: Partial<QuoteData> | null; error: { message: string } | null }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(quote) }),
      }),
    }),
  } as unknown as Parameters<typeof loadQuoteRenderInput>[0]["db"];
}

function makeAdminDb(opts: {
  tenant: { data: { name?: string } | null; error: { message: string } | null };
  host: { data: { value?: unknown } | null; error: { message: string } | null };
}) {
  return {
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(opts.tenant) }),
          }),
        };
      }
      // platform_settings
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(opts.host) }),
        }),
      };
    },
  } as unknown as Parameters<typeof loadQuoteRenderInput>[0]["adminDb"];
}

const BASE_QUOTE: QuoteData = {
  id: "quote-1",
  status: "draft",
  customer_access_token: null,
  cruise_line: "Norwegian",
  ship_name: "Bliss",
  sailing_date: "2026-09-15",
  duration_nights: 7,
  cabin_category: "Balcony",
  passenger_count: 2,
  total_amount: 1234.56,
  locked_price_cents: null,
  estimate_price_cents: 120000,
  price_lock_expires_at: null,
  priced_at: "2026-05-30T12:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadQuoteRenderInput", () => {
  it("returns ok with kind='estimate' when locked_price_cents is null", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: BASE_QUOTE, error: null }),
      adminDb: makeAdminDb({
        tenant: { data: { name: "Acme Travel" }, error: null },
        host: { data: { value: "Travel Pros LLC" }, error: null },
      }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.kind).toBe("estimate");
      expect(result.input.total_cents).toBe(120000);
      expect(result.input.tenant_name).toBe("Acme Travel");
      expect(result.input.host_agency_legal_name).toBe("Travel Pros LLC");
    }
  });

  it("returns ok with kind='confirmed' when locked_price_cents is set (drives banner + footer disclosure)", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({
        data: { ...BASE_QUOTE, locked_price_cents: 130000, estimate_price_cents: 120000 },
        error: null,
      }),
      adminDb: makeAdminDb({
        tenant: { data: { name: "Acme" }, error: null },
        host: { data: { value: "Host" }, error: null },
      }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.kind).toBe("confirmed");
      expect(result.input.total_cents).toBe(130000); // locked wins over estimate
    }
  });

  it("falls back to total_amount * 100 when neither locked nor estimate cents are set", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({
        data: { ...BASE_QUOTE, locked_price_cents: null, estimate_price_cents: null, total_amount: 99.95 },
        error: null,
      }),
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: "H" }, error: null },
      }),
      quoteId: "quote-1",
    });
    if (result.ok) {
      expect(result.input.total_cents).toBe(9995);
    }
  });

  it("tolerates platform_settings.value as a JSON object with .value (legacy shape)", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: BASE_QUOTE, error: null }),
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: { value: "Wrapped Host Name" } }, error: null },
      }),
      quoteId: "quote-1",
    });
    if (result.ok) {
      expect(result.input.host_agency_legal_name).toBe("Wrapped Host Name");
    }
  });

  it("falls back to defaults when tenant + host lookups return null rows", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: BASE_QUOTE, error: null }),
      adminDb: makeAdminDb({
        tenant: { data: null, error: null },
        host: { data: null, error: null },
      }),
      quoteId: "quote-1",
    });
    if (result.ok) {
      expect(result.input.tenant_name).toBe("Sub-host");
      expect(result.input.host_agency_legal_name).toBe("Host Agency");
    }
  });

  it("returns {ok:false, status:404} when the quote row is missing", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: null, error: null }),
      adminDb: makeAdminDb({
        tenant: { data: null, error: null },
        host: { data: null, error: null },
      }),
      quoteId: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe("not_found");
    }
  });

  it("returns {ok:false, status:500} when the quote SELECT errors (fail-loud, not silent default render)", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: null, error: { message: "connection refused" } }),
      adminDb: makeAdminDb({
        tenant: { data: null, error: null },
        host: { data: null, error: null },
      }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/connection refused/);
    }
  });

  it("returns {ok:false, status:500} when the tenant lookup errors (not 'Sub-host' fallback)", async () => {
    const result = await loadQuoteRenderInput({
      ctx: CTX,
      db: makeDb({ data: BASE_QUOTE, error: null }),
      adminDb: makeAdminDb({
        tenant: { data: null, error: { message: "tenants RLS" } },
        host: { data: { value: "H" }, error: null },
      }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/tenant lookup/);
    }
  });
});
