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

// Inventory db mock: dispatches on table name.
// - cruise_ships: single-eq lookup (slug → id). Pass shipId to simulate a catalog hit.
// - cruise_sailings: upsert captured in sailingUpserts; failSailingUpsert simulates a write error.
// - sailing_port_calls: upsert rows captured in portCallUpserts.
// - cruisemapper_url_inventory: two-eq lookup for enrichment status + upsert for mark-enriched.
function makeDb(
  enrichedStatus: string | null,
  options?: { shipId?: string; failSailingUpsert?: boolean },
) {
  const upserts: Array<Record<string, unknown>> = [];
  const sailingUpserts: Array<Record<string, unknown>> = [];
  const portCallUpserts: Array<unknown[]> = [];
  const shipId = options?.shipId ?? null;
  const failSailingUpsert = options?.failSailingUpsert ?? false;

  const db = {
    from: (table: string) => {
      if (table === "cruise_ships") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: shipId ? { id: shipId } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "cruise_sailings") {
        return {
          upsert: (row: Record<string, unknown>) => {
            sailingUpserts.push(row);
            return {
              select: () => ({
                single: async () =>
                  failSailingUpsert
                    ? { data: null, error: { message: "upsert_fail" } }
                    : { data: { id: "sail-stub" }, error: null },
              }),
            };
          },
        };
      }
      if (table === "sailing_port_calls") {
        return {
          upsert: (rows: unknown[]) => {
            portCallUpserts.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      // cruisemapper_url_inventory — enrichment check + mark-enriched upsert.
      return {
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
      };
    },
  } as unknown as Parameters<typeof processSailingHtml>[0];
  return { db, upserts, sailingUpserts, portCallUpserts };
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

  it("defers remaining sailings (no detail fetch) once the step deadline is reached (#842)", async () => {
    process.env.CRUISEMAPPER_DETAIL_FETCH_ENABLED = "true";
    const { db } = makeDb(null);
    const result = emptySailingResult();
    // Deadline already in the past → the detail loop must stop BEFORE the 1-req/sec
    // fetch so the Inngest step can't run past Vercel's maxDuration.
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result, Date.now() - 1000);

    expect(mocks.fetchPage).not.toHaveBeenCalled(); // no detail fetch under the deadline
    expect(result.list_details_fetched).toBe(0);
    expect(result.list_details_deferred).toBe(1); // the one upcoming sailing is deferred
    expect(listItemIngest()).toBeUndefined(); // and its list item did not ingest this run
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

// #827 follow-up — a future/unlaunched/river ship has a valid page (h1 + line)
// but NO current-sailing table. parseSailingPage returns null for it. The old
// code early-returned (skipping its upcoming list) AND counted it as a parse
// failure, which tripped the 5% halt. Now: not a failure (no_current_sailing),
// and its upcoming list is still ingested.
const FUTURE_SHIP_HTML = `<!doctype html><html><body>
<ol class="breadcrumb"><li><a href="https://www.cruisemapper.com/cruise-lines/Royal-Caribbean-2"><span itemprop="name">Royal Caribbean</span></a></li></ol>
<h1>Hero Of The Seas</h1>
<table class="shipTableCruise"><tbody>
<tr data-row="9999001"><td class="cruiseDatetime">2027 Jan 15</td><td class="cruiseTitle">7 days, round-trip Caribbean Round-trip Miami</td><td class="cruiseDeparture"><i class="flag-icon"></i> Miami </td><td class="cruisePrice">$1199</td></tr>
</tbody></table>
</body></html>`;

// No <h1> → not a recognizable ship page → a genuine parser break.
const UNRECOGNIZABLE_HTML = `<!doctype html><html><body><p>maintenance</p></body></html>`;

describe("processSailingHtml — no current sailing (future/river ship)", () => {
  it("treats a valid no-current-sailing ship as NOT a parse failure and still ingests its upcoming list", async () => {
    const { db } = makeDb(null);
    const result = emptySailingResult();
    await processSailingHtml(db, FUTURE_SHIP_HTML, "https://www.cruisemapper.com/ships/Hero-Of-The-Seas-2333", result);

    expect(result.no_current_sailing).toBe(1); // counted as valid, not a failure
    expect(result.current_parsed).toBe(0); // there is no current sailing
    expect(result.current_errors).toBe(0); // and that is NOT an error
    expect(result.list_items).toBe(1); // the upcoming list is still processed
    // The future sailing reaches RAG via the list path (identity = RCL).
    const ing = mocks.ingest.mock.calls.map((c) => c[0]).find((m) => m.key.sailDate === "2027-01-15");
    expect(ing).toBeDefined();
    expect(ing!.key.ship).toBe("Hero Of The Seas");
    expect(ing!.key.line).toBe("RCL");
  });

  it("still counts a page with no recognizable ship identity as a real parse failure", async () => {
    const { db } = makeDb(null);
    const result = emptySailingResult();
    await processSailingHtml(db, UNRECOGNIZABLE_HTML, "https://www.cruisemapper.com/ships/Broken-1", result);

    expect(result.current_errors).toBe(1); // genuine break — feeds the halt
    expect(result.no_current_sailing).toBe(0);
    expect(result.list_items).toBe(0);
  });
});

describe("processSailingHtml — catalog persistence (#783)", () => {
  const SHIP_ID = "cruise-ship-uuid-123";

  it("upserts cruise_sailings for current sailing and list item when ship is in catalog", async () => {
    const { db, sailingUpserts } = makeDb(null, { shipId: SHIP_ID });
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    // current sailing (2026-05-30, Seattle) + list item (2026-05-31, Port Canaveral)
    expect(sailingUpserts).toHaveLength(2);
    expect(sailingUpserts[0]).toMatchObject({
      cruise_ship_id: SHIP_ID,
      departure_date: "2026-05-30",
      departure_port: "Seattle, Washington",
      duration_nights: 7,
    });
    expect(sailingUpserts[1]).toMatchObject({
      cruise_ship_id: SHIP_ID,
      departure_date: "2026-05-31",
      departure_port: "Port Canaveral",
      duration_nights: 7,
    });
    expect(result.catalog_upserted).toBe(2);
    expect(result.catalog_errors).toBe(0);
  });

  it("upserts sailing_port_calls with correctly ordered rows when detail is fetched", async () => {
    vi.stubEnv("CRUISEMAPPER_DETAIL_FETCH_ENABLED", "true");
    mocks.fetchPage.mockResolvedValue({ status: "ok", body: JSON.stringify({ result: FRAGMENT }) });
    const { db, portCallUpserts } = makeDb(null, { shipId: SHIP_ID });
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);
    vi.unstubAllEnvs();

    // Detail was fetched for the one list item (current sailing has ports from parser).
    // At least one port-call upsert must have fired for the detail-enriched list item.
    expect(portCallUpserts.length).toBeGreaterThan(0);
    const rows = portCallUpserts[0] as Array<{ sailing_id: string; port_name: string; day_index: number }>;
    // day_index must be strictly ascending and start at 0.
    expect(rows[0]?.day_index).toBe(0);
    rows.forEach((r, i) => {
      expect(r.sailing_id).toBe("sail-stub");
      expect(r.day_index).toBe(i);
      expect(typeof r.port_name).toBe("string");
    });
  });

  it("skips catalog persistence when ship is not in catalog (null cruiseShipId)", async () => {
    const { db, sailingUpserts } = makeDb(null); // no shipId → lookup returns null
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    expect(sailingUpserts).toHaveLength(0);
    expect(result.catalog_upserted).toBe(0);
    expect(result.catalog_errors).toBe(0);
    // RAG ingest is unaffected — still fires for current + list item.
    expect(result.current_ingested).toBe(1);
    expect(result.list_ingested).toBe(1);
  });

  it("increments catalog_errors and does NOT abort RAG ingest when cruise_sailings upsert fails", async () => {
    const { db } = makeDb(null, { shipId: SHIP_ID, failSailingUpsert: true });
    const result = emptySailingResult();
    await processSailingHtml(db, SHIP_HTML, SHIP_URL, result);

    expect(result.catalog_errors).toBeGreaterThan(0);
    expect(result.catalog_upserted).toBe(0);
    // RAG ingest still completes — catalog failure is non-fatal.
    expect(result.current_ingested).toBe(1);
    expect(result.list_ingested).toBe(1);
  });
});
