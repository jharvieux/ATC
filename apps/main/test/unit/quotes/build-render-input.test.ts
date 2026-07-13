// §12.4 / §21.10.1 / §38 — loadQuoteRow + buildRenderInputFromQuote.
//
// Contracts pinned here:
//   1. Kind + variance are the AUTHORITATIVE derivation shared with the
//      accept route (#1699): kind comes from the persisted price_kind column
//      (NOT a locked_price_cents heuristic), and variance from the tenant's
//      quote_variance_cents (env default when unset, 0 for confirmed). The
//      renderer's banner copy + footer disclosure and the customer-accepted
//      variance threshold key off these — a downloadable PDF that disagrees
//      with the accepted snapshot is the dispute-defense hole #1699 closed.
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
import { deriveKindAndVariance } from "@/lib/quotes/kind-variance";
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
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve(quote) }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof loadQuoteRow>[0]["db"];
}

type OptionResult = {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
};

function makeAdminDb(opts: {
  // #1190: the tenant display label is the display_name column (there is no
  // "name" column on tenants). Keying the mock on the real column makes this a
  // regression guard — reverting the reader to .name resolves to undefined here.
  tenant: { data: { display_name?: string } | null; error: { message: string } | null };
  host: { data: { value?: unknown } | null; error: { message: string } | null };
  options: OptionResult;
  // #1699: tenant_settings.quote_variance_cents drives the render variance.
  // Default null → env fallback, matching a tenant that hasn't customized it.
  settings?: { data: { quote_variance_cents?: number } | null; error: { message: string } | null };
}) {
  const settings = opts.settings ?? { data: null, error: null };
  return {
    from: (table: string) => {
      if (table === "tenants") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(opts.tenant) }),
          }),
        };
      }
      if (table === "tenant_settings") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => Promise.resolve(settings) }),
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
  price_kind: null,
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
  tenant: { data: { display_name: "Acme Travel" }, error: null },
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
      tenant_id: TENANT_ID,
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
      tenant_id: TENANT_ID,
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
      tenant_id: TENANT_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/connection refused/);
    }
  });
});

describe("buildRenderInputFromQuote — enrich with tenant + host + option", () => {
  it("returns kind='estimate' when price_kind is null (DB default)", async () => {
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

  // #1699 regression: the OLD derivation used `locked_price_cents != null`,
  // which would call this quote "confirmed". The authoritative source is the
  // persisted price_kind column — a locked amount with price_kind still
  // 'estimate' (e.g. a lock that expired) must render as an estimate.
  it("kind follows price_kind, NOT locked_price_cents (guards the #1699 divergence)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich }),
      quote: { ...BASE_QUOTE, price_kind: "estimate", locked_price_cents: 130000 },
    });
    if (result.ok) {
      expect(result.input.kind).toBe("estimate");
      expect(result.input.total_cents).toBe(130000); // locked still wins for the total
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

  it("returns kind='confirmed' when price_kind='confirmed' (drives banner + footer disclosure)", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich }),
      quote: { ...BASE_QUOTE, price_kind: "confirmed", locked_price_cents: 130000, estimate_price_cents: 120000 },
    });
    if (result.ok) {
      expect(result.input.kind).toBe("confirmed");
      expect(result.input.total_cents).toBe(130000); // locked wins over estimate
      expect(result.input.variance_cents).toBe(0); // confirmed → zero variance
    }
  });

  it("uses the customer-selected option's trip + total over a lower-index option", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { display_name: "T" }, error: null },
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
        tenant: { data: { display_name: "T" }, error: null },
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
        tenant: { data: { display_name: "T" }, error: null },
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
        tenant: { data: { display_name: "T" }, error: null },
        host: { data: { value: { value: "Wrapped Host Name" } }, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    if (result.ok) {
      expect(result.input.host_agency_legal_name).toBe("Wrapped Host Name");
    }
  });

  // §20.7 fail-closed (#1877/#1883): the rendered PDF carries the
  // tenant-of-record legal disclosure. A missing tenant display_name or
  // host-agency legal name must fail loud (500), NEVER render a fabricated
  // "Sub-host" / "Host Agency" placeholder into a customer-facing legal
  // document. This is the same fail-open-disclosure class #1856 fixed for the
  // Review stage — the test fails if a placeholder fallback is reintroduced.
  it("fails closed (500, no placeholder) when the host-agency legal name is missing", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { display_name: "Acme Travel" }, error: null },
        host: { data: null, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/host_agency_legal_name/);
      // The message must never be the fabricated legal name.
      expect(result.message).not.toBe("Host Agency");
    }
  });

  it("fails closed (500, no placeholder) when the tenant display_name is missing", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: null, error: null },
        host: { data: { value: "Travel Pros LLC" }, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/display_name/);
      expect(result.message).not.toBe("Sub-host");
    }
  });

  it("returns null (never a placeholder) when platform_settings.value is a malformed object", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        tenant: { data: { display_name: "Acme Travel" }, error: null },
        host: { data: { value: {} }, error: null },
        options: { data: [BASE_OPTION], error: null },
      }),
      quote: BASE_QUOTE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toMatch(/host_agency_legal_name/);
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
        tenant: { data: { display_name: "T" }, error: null },
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
        tenant: { data: { display_name: "T" }, error: null },
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

// #1699 — variance_cents comes from tenant_settings.quote_variance_cents, not
// a raw env read. Before the fix the downloadable PDF ignored tenant_settings
// entirely, so a tenant with a customized threshold saw the WRONG variance vs
// the accepted snapshot.
describe("buildRenderInputFromQuote — variance from tenant_settings (#1699)", () => {
  it("uses the tenant's customized quote_variance_cents for an estimate", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        ...okEnrich,
        settings: { data: { quote_variance_cents: 7500 }, error: null },
      }),
      quote: { ...BASE_QUOTE, price_kind: "estimate" },
    });
    if (result.ok) {
      expect(result.input.variance_cents).toBe(7500);
    }
  });

  it("forces variance_cents=0 for a confirmed quote even when tenant_settings has a value", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({
        ...okEnrich,
        settings: { data: { quote_variance_cents: 7500 }, error: null },
      }),
      quote: { ...BASE_QUOTE, price_kind: "confirmed" },
    });
    if (result.ok) {
      expect(result.input.variance_cents).toBe(0);
    }
  });

  it("falls back to the env default when the tenant has no quote_variance_cents", async () => {
    const result = await buildRenderInputFromQuote({
      ctx: CTX,
      adminDb: makeAdminDb({ ...okEnrich, settings: { data: null, error: null } }),
      quote: { ...BASE_QUOTE, price_kind: "estimate" },
    });
    if (result.ok) {
      // Assert against the shared SoT rather than a literal so the test isn't
      // coupled to the env default's numeric value.
      const expected = deriveKindAndVariance({ price_kind: "estimate", tenant_variance_cents: undefined });
      expect(result.input.variance_cents).toBe(expected.variance_cents);
    }
  });
});

// #1699 cross-path guard: the downloadable-PDF path (buildRenderInputFromQuote)
// and the accept-time snapshot (api/quotes/[id]/accept) MUST show the same kind
// + variance for the same quote row. Both now delegate to deriveKindAndVariance;
// this asserts the PDF path's output equals that shared source of truth across
// the full (price_kind × tenant_variance) matrix. If buildRenderInputFromQuote
// were reverted to its own derivation (the #1699 bug), one of these fails.
describe("buildRenderInputFromQuote — agrees with the shared accept-route derivation (#1699)", () => {
  const priceKinds: Array<"estimate" | "confirmed" | null> = ["estimate", "confirmed", null];
  const tenantVariances: Array<number | null> = [null, 7500];

  for (const price_kind of priceKinds) {
    for (const variance of tenantVariances) {
      it(`kind=${price_kind} variance=${variance}: PDF path == deriveKindAndVariance`, async () => {
        const expected = deriveKindAndVariance({
          price_kind,
          tenant_variance_cents: variance ?? undefined,
        });
        const result = await buildRenderInputFromQuote({
          ctx: CTX,
          adminDb: makeAdminDb({
            ...okEnrich,
            settings: { data: variance == null ? null : { quote_variance_cents: variance }, error: null },
          }),
          quote: { ...BASE_QUOTE, price_kind },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.input.kind).toBe(expected.kind);
          expect(result.input.variance_cents).toBe(expected.variance_cents);
        }
      });
    }
  }
});
