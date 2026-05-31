// #485 follow-up §33.4 — sailing-list-parser unit tests.
//
// Fixtures mirror the verified live structure of table.shipTableCruise on
// a CruiseMapper ship page (live-fetched 2026-05-30, Norwegian Bliss):
//   td.cruiseDatetime  "YYYY Mon DD"
//   td.cruiseTitle     "N days, <type> <region> ..."
//   td.cruiseDeparture flag <i> + city text
//   td.cruisePrice     "$NNN" or "$N,NNN"

import { describe, expect, it } from "vitest";
import { parseSailingList } from "../../../src/lib/external/cruisemapper/parsers/sailing-list-parser";

const FIXTURE_BLISS = `
<!doctype html><html><body>
<table class="table table-responsive table-striped shipTableCruise">
  <thead><tr><th>Date</th><th>Itinerary</th><th class="cruiseDeparture">Departure Port</th><th>From</th></tr></thead>
  <tbody>
    <tr data-row="4869927" data-state="0">
      <td class="cruiseDatetime">2026 Apr 25</td>
      <td class="cruiseTitle"> 7 days, round-trip Alaska Round-trip Seattle Juneau, Ketchikan  Victoria </td>
      <td class="cruiseDeparture"><i title="Washington" class="flag-icon flag-icon-us"></i> Seattle </td>
      <td class="cruisePrice">$789</td>
    </tr>
    <tr data-row="4869932" data-state="0">
      <td class="cruiseDatetime">2026 May 30</td>
      <td class="cruiseTitle"> 7 days, round-trip Alaska Round-trip Seattle Juneau, Ketchikan  Victoria </td>
      <td class="cruiseDeparture"><i title="Washington" class="flag-icon flag-icon-us"></i> Seattle </td>
      <td class="cruisePrice">$919</td>
    </tr>
    <tr data-row="4869952" data-state="0">
      <td class="cruiseDatetime">2026 Oct 13</td>
      <td class="cruiseTitle"> 16 days, one-way from Los Angeles to Miami <i class="fa fa-diamond pull-right"></i></td>
      <td class="cruiseDeparture"><i title="Long Beach-San Pedro, California" class="flag-icon flag-icon-us"></i> Los Angeles </td>
      <td class="cruisePrice">$2,179</td>
    </tr>
    <tr data-row="4869953" data-state="0">
      <td class="cruiseDatetime">2026 Nov 01</td>
      <td class="cruiseTitle"> 8 days, round-trip Bahamas Round-trip New York Great Stirrup Cay, Orlando  Nassau </td>
      <td class="cruiseDeparture"><i title="NYC Manhattan-Brooklyn" class="flag-icon flag-icon-us"></i> New York </td>
      <td class="cruisePrice">$999</td>
    </tr>
  </tbody>
</table>
</body></html>
`;

// Page with no shipTableCruise — should return empty array, not throw.
const FIXTURE_NO_TABLE = `<html><body><h1>Some Ship</h1></body></html>`;

describe("parseSailingList", () => {
  it("parses all rows: date, title, port, duration, price", () => {
    const items = parseSailingList(FIXTURE_BLISS);
    expect(items).toHaveLength(4);

    const first = items[0]!;
    expect(first.data_row_id).toBe("4869927");
    expect(first.departure_date).toBe("2026-04-25");
    expect(first.duration_nights).toBe(7);
    expect(first.departure_port).toBe("Seattle");
    expect(first.starting_price_usd).toBe(789);
    expect(first.region).toBe("Alaska");
  });

  it("parses the current sailing row with the known price", () => {
    const items = parseSailingList(FIXTURE_BLISS);
    const may30 = items.find((i) => i.departure_date === "2026-05-30");
    expect(may30).toBeDefined();
    expect(may30?.starting_price_usd).toBe(919);
    expect(may30?.data_row_id).toBe("4869932");
  });

  it("parses comma-formatted price ($2,179) correctly", () => {
    const items = parseSailingList(FIXTURE_BLISS);
    const oct = items.find((i) => i.data_row_id === "4869952");
    expect(oct?.starting_price_usd).toBe(2179);
    expect(oct?.duration_nights).toBe(16);
    expect(oct?.departure_port).toBe("Los Angeles");
    // Panama Canal is in REGION_TOKENS but the title here says "one-way from Los Angeles to Miami" — no region keyword.
    expect(oct?.region).toBeNull();
  });

  it("strips the cruiseTitle <i> icon from the title text", () => {
    const items = parseSailingList(FIXTURE_BLISS);
    const oct = items.find((i) => i.data_row_id === "4869952");
    expect(oct?.title).not.toMatch(/fa-diamond/);
    expect(oct?.title).toMatch(/16 days/);
  });

  it("extracts Bahamas region from the title", () => {
    const items = parseSailingList(FIXTURE_BLISS);
    const nov = items.find((i) => i.data_row_id === "4869953");
    expect(nov?.region).toBe("Bahamas");
    expect(nov?.departure_port).toBe("New York");
  });

  it("returns [] when the shipTableCruise table is absent", () => {
    expect(parseSailingList(FIXTURE_NO_TABLE)).toEqual([]);
  });
});
