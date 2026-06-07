// #827 — processSailingHtml per-sailing detail enrichment.
//
// Verifies the WHY, not just the wiring: when detail fetching is enabled, an
// upcoming sailing's REAL ports (from /ships/cruise.json) must reach the RAG
// ingest payload; an already-enriched sailing must NOT be re-fetched or
// re-ingested (ports are immutable once scheduled); and with the kill-switch
// off, behaviour is unchanged (no detail fetch, no ports).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  ingest: vi.fn(async (_m: import("../../../src/lib/external/cruisemapper/itinerary-mapper").MappedItinerary) => ({ status: "ingested" as const })),
  upsertPrice: vi.fn(async () => undefined),
}));

vi.mock("../../../src/lib/external/cruisemapper/diy-fetcher", () => ({
  fetchCruiseMapperPage: mocks.fetchPage,
}));
vi.mock("../../../src/lib/external/cruisemapper/rag-itinerary-ingest", () => ({
  ingestItineraryToRag: mocks.ingest,
}));
vi.mock("@/lib/pricing/pricing-cache", () => ({ upsertPriceQuote: mocks.upsertPrice }));

import { processSailingHtml, emptySailingResult } from "../../../src/lib/external/cruisemapper/sailing-ingest";
import type { MappedItinerary } from "../../../src/lib/external/cruisemapper/itinerary-mapper";

const FRAGMENT = (JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/cruisemapper/cruise-detail-4885894.json"), "utf-8"),
) as { result: string }).result;

// Ship page: a current sailing (so parseSailingPage succeeds) + a one-row
// upcoming list whose detail we enrich. The list row date (05-31) differs from
// the current sailing (05-30) so we can target the list item's ingest call.
const SHIP_HTML = `<!doctype html><html><body>
<ol class="breadcrumb"><li><a href="https://www.cruisemapper.com/cruise-lines/Norwegian-Cruise-Line-10"><span itemprop="name">Norwegian Cruise Line</span></a></li></ol>
<h1>Norwegian Prima</h1>
<h3 id="current_cruise">Current itinerary of Norwegian Prima</h3>
<p> <strong>7 days, round-trip Alaska</strong>. Prices start from USD 919. The itinerary begins on <strong>May 30, 2026</strong> and ends on <strong>June 6, 2026</strong>. </p>
<div class="cruiseItineraries cruiseItinerariesCurrent"><table>
<tr><td class="date">30 May 16:00</td><td class="text"><strong>Departing</strong> from <a href="https://www.cruisemapper.com/ports/seattle-port-6">Seattle, Washington</a></td></tr>
<tr><td class="date">06 Jun 07:00</td><td class="text"><strong>Arriving</strong> in <a href="https://www.cruisemapper.com/ports/seattle-port-6">Seattle, Washington</a></td></tr>
</table></div>
<table class="shipTableCruise"><tbody>
<tr data-row="4885894"><td class="cruiseDatetime">2026 May 31</td><td class="cruiseTitle">7 days, round-trip Caribbean Round-trip Orlando</td><td class="cruiseDeparture"><i class="flag-icon"></i> Port Canaveral </td><td class="cruisePrice">$1029</td></tr>
</tbody></table>
</body></html>`;

const SHIP_URL = "https://www.cruisemapper.com/ships/Norwegian-Prima-2216";

// Inventory db mock: select(...).eq.eq.maybeSingle resolves the enriched status;
// upsert records the mark-enriched calls.
function makeDb(enrichedStatus: string | null) {
  const upserts: Array<Record<string, unknown>> = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: enrichedStatus ? { last_ingest_status: enrichedStatus } : null,
              error: null,
            }),
          }),
        }),
      }),
      upsert: (row: Record<string, unknown>) => {
        upserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as Parameters<typeof processSailingHtml>[0];
  return { db, upserts };
}

function listItemIngest(): MappedItinerary | undefined {
  return mocks.ingest.mock.calls
    .map((c) => c[0])
    .find((m) => m.key.sailDate === "2026-05-31");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingest.mockResolvedValue({ status: "ingested" });
  delete process.env.CRUISEMAPPER_DETAIL_FETCH_ENABLED;
});

describe("processSailingHtml — #827 detail enrichment", () => {
  it("does NOT fetch detail and maps no ports when the kill-switch is off", async () => {
    const { db } = makeDb(null);
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(result.list_details_fetched).toBe(0);
    expect(listItemIngest()?.portsOfCall).toEqual([]);
  });

  it("fetches the detail and the REAL ports reach the RAG ingest, then marks enriched", async () => {
    process.env.CRUISEMAPPER_DETAIL_FETCH_ENABLED = "true";
    mocks.fetchPage.mockResolvedValue({
      status: "ok",
      body: JSON.stringify({ result: FRAGMENT }),
      bodyHash: "h",
      latencyMs: 1,
      url: "x",
    });
    const { db, upserts } = makeDb(null);
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    // Detail endpoint hit with the row id from the list.
    expect(mocks.fetchPage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPage.mock.calls[0]![0]).toContain("cruise.json?id=4885894");
    expect(result.list_details_fetched).toBe(1);

    const ports = listItemIngest()?.portsOfCall ?? [];
    expect(ports).toContain("Great Stirrup Cay, Bahamas NCL private island");
    expect(ports).toHaveLength(4);

    // Marked enriched so a later run skips the fetch.
    expect(upserts.some((u) => u.kind === "sailing_detail" && u.last_ingest_status === "ingested")).toBe(true);
  });

  it("skips fetch AND re-ingest for an already-enriched sailing", async () => {
    process.env.CRUISEMAPPER_DETAIL_FETCH_ENABLED = "true";
    const { db } = makeDb("ingested");
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    expect(mocks.fetchPage).not.toHaveBeenCalled();
    expect(result.list_details_skipped_enriched).toBe(1);
    // The current sailing still ingests; the (enriched) list item does not.
    expect(listItemIngest()).toBeUndefined();
    // But the price cache STILL refreshes for enriched sailings — the lead-in
    // price the pricing anchors read drifts even though ports don't.
    expect(mocks.upsertPrice).toHaveBeenCalled();
  });
});
