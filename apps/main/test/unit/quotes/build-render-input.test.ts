// §12.4 / §21.10.1 / §38 — loadQuoteRow + buildRenderInputFromQuote.
//
// Contracts pinned here:
//   1. Kind selection: a quote with a locked_price_cents lands as
//      "confirmed"; otherwise "estimate". The renderer's banner copy and
//      footer disclosure key off this — getting it wrong sends the wrong
//      legal disclosure on the customer attachment.
//   2. §38 trip source-of-truth: the cruise/ship/sailing/cabin/pax fields on
//      the rendered PDF come from the representative quote_options row
//      (customer-selected, else lowest option_index), NOT from the quotes
//      container (those columns were dropped in the §38 contract migration).
//   3. Total-cents fallback: locked → estimate → representative option
//      total_amount_cents → 0.
//   4. host_agency_legal_name shape tolerance: platform_settings.value can be
//      a string OR a JSON object with a `.value` field. The send route
//      shipped with both forms in the wild.
//   5. The loader stays cheap (one container SELECT) so /send can
//      short-circuit non-draft sends with a 409 before paying the tenant +
//      platform_settings + quote_options lookups buildRenderInputFromQuote
//      does.
//   6. Failure modes surface as a structured non-ok result with HTTP status —
//      both the agent download and the customer send rely on the helper to
//      fail loud instead of silently rendering with bad data. The
//      quote_options read is part of that: a read error is a 500, not a
//      silent render with blank trip detail.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadQuoteRow,
  buildRenderInputFromQuote,
  type QuoteRow,
} from "@/lib/quotes/build-render-input";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const CTX: TenantContext = {
  tenant_id: TENANT_ID,
  source: { kind: "http_request", user_id: "user-1" },
};

function makeDb(quote: { data: Partial<QuoteRow> | null; error: { message: string } | null }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve(quote) }),
      }),
    }),
  } as unknown as Parameters<typeof loadQuoteRow>[0]["db"];
}

type OptionResult = {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
};

function makeAdminDb(opts: {
  tenant: { data: { name?: string } | null; error: { message: string } | null };
  host: { data: { value?: unknown } | null; error: { message: string } | null };
  options: OptionResult;
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
      if (table === "quote_options") {
        // .select(...).eq("tenant_id",…).eq("quote_id",…).order(…)
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ order: () => Promise.resolve(opts.options) }),
            }),
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
  } as unknown as Parameters<typeof buildRenderInputFromQuote>[0]["adminDb"];
}

const BASE_QUOTE: QuoteRow = {
  id: "quote-1",
  status: "draft",
  customer_access_token: null,
  locked_price_cents: null,
  estimate_price_cents: 120000,
  price_lock_expires_at: null,
  priced_at: "2026-05-30T12:00:00Z",
};

const BASE_OPTION = {
  option_index: 1,
  customer_selected: false,
  cruise_line: "Norwegian",
  ship_name: "Bliss",
  sailing_date: "2026-09-15",
  duration_nights: 7,
  cabin_category: "Balcony",
  passenger_count: 2,
  total_amount_cents: 123456,
};

const okEnrich = {
  tenant: { data: { name: "Acme Travel" }, error: null },
  host: { data: { value: "Travel Pros LLC" }, error: null },
  options: { data: [BASE_OPTION], error: null },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadQuoteRow — cheap container SELECT for status branching", () => {
  it("returns ok with the typed row on success", async () => {
    const result = await loadQuoteRow({
      db: makeDb({ data: BASE_QUOTE, error: null }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quote.id).toBe("quote-1");
      expect(result.quote.status).toBe("draft");
    }
  });

  it("returns {ok:false, status:404} when the row is missing", async () => {
    const result = await loadQuoteRow({
      db: makeDb({ data: null, error: null }),
      quoteId: "missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.message).toBe("not_found");
    }
  });

  it("returns {ok:false, status:500} on DB error (fail-loud, not silent default render)", async () => {
    const result = await loadQuoteRow({
      db: makeDb({ data: null, error: { message: "connection refused" } }),
      quoteId: "quote-1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/connection refused/);
    }
  });
});

describe("buildRenderInputFromQuote — enrich with tenant + host + option", () => {
  it("returns kind='estimate' when locked_price_cents is null", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.kind).toBe("estimate");
      expect(result.input.total_cents).toBe(120000);
      expect(result.input.tenant_name).toBe("Acme Travel");
      expect(result.input.host_agency_legal_name).toBe("Travel Pros LLC");
    }
  });

  it("reads the trip detail from the representative quote_options row (§38)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich }),
      quote: BASE_QUOTE,
    });
    if (result.ok) {
      expect(result.input.cruise_line).toBe("Norwegian");
      expect(result.input.ship_name).toBe("Bliss");
      expect(result.input.sailing_date).toBe("2026-09-15");
      expect(result.input.duration_nights).toBe(7);
      expect(result.input.cabin_category).toBe("Balcony");
      expect(result.input.passenger_count).toBe(2);
    }
  });

  it("returns kind='confirmed' when locked_price_cents is set (drives banner + footer disclosure)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich }),
      quote: { ...BASE_QUOTE, locked_price_cents: 130000, estimate_price_cents: 120000 },
    });
    if (result.ok) {
      expect(result.input.kind).toBe("confirmed");
      expect(result.input.total_cents).toBe(130000); // locked wins over estimate
    }
  });

  it("uses the customer-selected option's trip + total over a lower-index option", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: "H" }, error: null },
        options: {
          data: [
            { ...BASE_OPTION, option_index: 1, customer_selected: false, cruise_line: "Royal", total_amount_cents: 100000 },
            { ...BASE_OPTION, option_index: 2, customer_selected: true, cruise_line: "Celebrity", total_amount_cents: 200000 },
          ],
          error: null,
        },
      }),
      // No locked/estimate on the container → the chosen option's total wins.
      quote: { ...BASE_QUOTE, locked_price_cents: null, estimate_price_cents: null },
    });
    if (result.ok) {
      expect(result.input.cruise_line).toBe("Celebrity");
      expect(result.input.total_cents).toBe(200000);
    }
  });

  it("falls back to the representative option total_amount_cents when neither locked nor estimate cents are set", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: "H" }, error: null },
        options: { data: [{ ...BASE_OPTION, total_amount_cents: 9995 }], error: null },
      }),
      quote: { ...BASE_QUOTE, locked_price_cents: null, estimate_price_cents: null },
    });
    if (result.ok) {
      expect(result.input.total_cents).toBe(9995);
    }
  });

  it("renders with null trip detail + 0 total for a container with no options", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: "H" }, error: null },
        options: { data: [], error: null },
      }),
      quote: { ...BASE_QUOTE, locked_price_cents: null, estimate_price_cents: null },
    });
    if (result.ok) {
      expect(result.input.cruise_line).toBeNull();
      expect(result.input.total_cents).toBe(0);
    }
  });

  it("tolerates platform_settings.value as a JSON object with .value (legacy shape)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: { value: "Wrapped Host Name" } }, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    if (result.ok) {
      expect(result.input.host_agency_legal_name).toBe("Wrapped Host Name");
    }
  });

  it("falls back to defaults when tenant + host lookups return null rows", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: null, error: null },
        host: { data: null, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    if (result.ok) {
      expect(result.input.tenant_name).toBe("Sub-host");
      expect(result.input.host_agency_legal_name).toBe("Host Agency");
    }
  });

  it("returns {ok:false, status:500} when the tenant lookup errors", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: null, error: { message: "tenants RLS" } },
        host: { data: { value: "H" }, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/tenant lookup/);
    }
  });

  it("returns {ok:false, status:500} when the host lookup errors", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: null, error: { message: "platform_settings RLS" } },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/host lookup/);
    }
  });

  it("returns {ok:false, status:500} when the quote_options lookup errors (fail-loud)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { name: "T" }, error: null },
        host: { data: { value: "H" }, error: null },
        options: { data: null, error: { message: "quote_options RLS" } },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/options lookup/);
    }
  });
});
