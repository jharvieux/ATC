// #485 §33.4 — sailing-parser unit tests.
//
// Fixtures mirror the real CruiseMapper ship-page markup verified against a
// live fetch on 2026-05-30 (div.cruiseItinerariesCurrent > table with
// td.date / td.text, /ports/ links, Departing/Arriving markers, a hotels
// link that must be excluded, and the #current_cruise prose carrying the
// year + price). Sea days are NOT rows — they are gaps the parser fills.

import { describe, expect, it } from "vitest";
import { parseSailingPage } from "../../../src/lib/external/cruisemapper/parsers/sailing-parser";

// Assert the parse succeeded first, so a fixture regression surfaces as a
// named "expected null" failure rather than an opaque null-deref later.
function parse(html: string, url = "https://x.test/ships/y-1") {
  const s = parseSailingPage(html, url);
  expect(s).not.toBeNull();
  return s!;
}

// Round-trip Alaska from Seattle. Exercises: implicit sea day (no 31 May
// row), a same-date double stop (02 Jun: Tracy Arm + Juneau), a scenic stop
// with no times (Tracy Arm), the excluded hotels link, and a Canada flag.
const FIXTURE_ALASKA = `
<!doctype html><html><body>
<ol class="breadcrumb">
  <li><a href="https://www.cruisemapper.com/cruise-lines/Norwegian-Cruise-Line-10"><span itemprop="name">Norwegian Cruise Line</span></a></li>
</ol>
<h1>Norwegian Bliss</h1>
<h3 class="contentTitle" id="current_cruise">Current itinerary of Norwegian Bliss</h3>
<p> Norwegian Bliss current cruise is a <strong>7 days, round-trip Alaska Round-trip Seattle Juneau, Ketchikan Victoria</strong>. Prices start from USD 919 (double occupancy rates). The itinerary begins on <strong>May 30, 2026</strong> and ends on <strong>June 6, 2026</strong>. </p>
<div class="row cruiseItem cruiseItemCurrent">
  <div class="col-xs-12 cruiseItineraries cruiseItinerariesCurrent">
    <table class="table table-bordered">
      <tr><th>Date / Time</th><th class="labelPort">Port</th></tr>
      <tr><td class="date">30 May 16:00</td><td class="text"><i class="fa fa-flag"></i> <strong>Departing</strong> from <a href="https://www.cruisemapper.com/ports/seattle-port-6">Seattle, Washington</a><a class="itineraryHotelsText" href="https://www.cruisemapper.com/ports/seattle-port-6?tab=hotels#hotels"><i class="fa fa-hotel"></i> hotels</a></td></tr>
      <tr><td class="date">01 Jun 10:00 - 18:00</td><td class="text"><i class="fa fa-anchor"></i> <a href="https://www.cruisemapper.com/ports/sitka-port-126">Sitka, Baranof Island Alaska</a></td></tr>
      <tr><td class="date">02 Jun</td><td class="text"><i class="fa fa-anchor"></i> <a href="https://www.cruisemapper.com/ports/tracy-arm-fjord-port-4885">Tracy Arm Fjord, Alaska</a></td></tr>
      <tr><td class="date">02 Jun 06:30 - 13:30</td><td class="text"><i class="fa fa-anchor"></i> <a href="https://www.cruisemapper.com/ports/juneau-port-407">Juneau, Alaska</a></td></tr>
      <tr><td class="date">04 Jun 06:00 - 13:15</td><td class="text"><i class="fa fa-anchor"></i> <a href="https://www.cruisemapper.com/ports/ketchikan-port-409">Ketchikan, Revillagigedo Island Alaska</a></td></tr>
      <tr><td class="date">05 Jun 20:00 - 23:59</td><td class="text"><i class="fa fa-anchor"></i> <a href="https://www.cruisemapper.com/ports/victoria-bc-port-3">Victoria BC, Vancouver Island Canada</a></td></tr>
      <tr><td class="date">06 Jun 07:00</td><td class="text"><i class="fa fa-flag-checkered"></i> <strong>Arriving</strong> in <a href="https://www.cruisemapper.com/ports/seattle-port-6">Seattle, Washington</a><a class="itineraryHotelsText" href="https://www.cruisemapper.com/ports/seattle-port-6?tab=hotels#hotels"><i class="fa fa-hotel"></i> hotels</a></td></tr>
    </table>
  </div>
</div>
</body></html>
`;

// Round-trip Caribbean from Miami spanning a year boundary (Dec → Jan).
// Exercises: multiple sea-day gaps and the year rollover.
const FIXTURE_CARIBBEAN_ROLLOVER = `
<!doctype html><html><body>
<ol class="breadcrumb"><li><a href="https://www.cruisemapper.com/cruise-lines/Royal-Caribbean-2"><span itemprop="name">Royal Caribbean</span></a></li></ol>
<h1>Symphony of the Seas</h1>
<h3 id="current_cruise">Current itinerary of Symphony of the Seas</h3>
<p> <strong>7 days, round-trip Caribbean Round-trip Miami</strong>. Prices start from USD 1,249. The itinerary begins on <strong>December 28, 2026</strong> and ends on <strong>January 4, 2027</strong>. </p>
<div class="cruiseItineraries cruiseItinerariesCurrent">
  <table class="table table-bordered">
    <tr><th>Date / Time</th><th>Port</th></tr>
    <tr><td class="date">28 Dec 17:00</td><td class="text"><strong>Departing</strong> from <a href="https://www.cruisemapper.com/ports/miami-port-9">Miami, Florida</a></td></tr>
    <tr><td class="date">30 Dec 08:00 - 17:00</td><td class="text"><a href="https://www.cruisemapper.com/ports/nassau-port-30">Nassau, Bahamas</a></td></tr>
    <tr><td class="date">01 Jan 10:00 - 18:00</td><td class="text"><a href="https://www.cruisemapper.com/ports/cococay-port-99">CocoCay, Bahamas</a></td></tr>
    <tr><td class="date">03 Jan 09:00 - 16:00</td><td class="text"><a href="https://www.cruisemapper.com/ports/cozumel-port-12">Cozumel, Mexico</a></td></tr>
    <tr><td class="date">04 Jan 07:00</td><td class="text"><strong>Arriving</strong> in <a href="https://www.cruisemapper.com/ports/miami-port-9">Miami, Florida</a></td></tr>
  </table>
</div>
</body></html>
`;

describe("parseSailingPage", () => {
  it("parses ship, line, dates, ports and price from the current-itinerary block", () => {
    const s = parseSailingPage(FIXTURE_ALASKA, "https://www.cruisemapper.com/ships/Norwegian-Bliss-1454");
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.ship_name).toBe("Norwegian Bliss");
    expect(s.cruise_line).toBe("Norwegian Cruise Line");
    expect(s.departure_date).toBe("2026-05-30");
    expect(s.return_date).toBe("2026-06-06");
    expect(s.duration_nights).toBe(7);
    expect(s.departure_port).toBe("Seattle, Washington");
    expect(s.region).toBe("Alaska");
    expect(s.starting_price_usd).toBe(919);
    expect(s.ship_slug).toBe("Norwegian-Bliss-1454");
    expect(s.sailing_slug).toBe("Norwegian-Bliss-1454__2026-05-30");
  });

  it("reconstructs the implicit sea day from the calendar gap", () => {
    const s = parse(FIXTURE_ALASKA, "https://x.test/ships/y-1");
    // 31 May has NO row — it must appear as an at-sea day, not be dropped.
    const may31 = s.itinerary.filter((d) => d.date === "2026-05-31");
    expect(may31).toHaveLength(1);
    expect(may31[0]?.port_name).toBeNull();
    expect(may31[0]?.day_number).toBe(2);
  });

  it("keeps both stops that share a calendar date under one day number", () => {
    const s = parse(FIXTURE_ALASKA, "https://x.test/ships/y-1");
    const jun2 = s.itinerary.filter((d) => d.date === "2026-06-02");
    expect(jun2.map((d) => d.port_name)).toEqual(["Tracy Arm Fjord, Alaska", "Juneau, Alaska"]);
    expect(jun2.every((d) => d.day_number === 4)).toBe(true);
    // Scenic stop has no times; the timed stop carries arrival+departure.
    expect(jun2[0]?.arrival_time).toBeNull();
    expect(jun2[1]?.arrival_time).toBe("06:30");
    expect(jun2[1]?.departure_time).toBe("13:30");
  });

  it("excludes the embark/disembark turnaround port and sea days from ports_of_call", () => {
    const s = parse(FIXTURE_ALASKA, "https://x.test/ships/y-1");
    expect(s.ports_of_call).toEqual([
      "Sitka, Baranof Island Alaska",
      "Tracy Arm Fjord, Alaska",
      "Juneau, Alaska",
      "Ketchikan, Revillagigedo Island Alaska",
      "Victoria BC, Vancouver Island Canada",
    ]);
    // The "hotels" link in the same cell must not pollute the port name.
    expect(s.ports_of_call.some((p) => /hotel/i.test(p))).toBe(false);
  });

  it("records embark departure time and disembark arrival time", () => {
    const s = parse(FIXTURE_ALASKA, "https://x.test/ships/y-1");
    const first = s.itinerary[0]!;
    expect(first.day_number).toBe(1);
    expect(first.departure_time).toBe("16:00");
    expect(first.arrival_time).toBeNull();
    const last = s.itinerary[s.itinerary.length - 1]!;
    expect(last.port_name).toBe("Seattle, Washington");
    expect(last.arrival_time).toBe("07:00");
    expect(last.departure_time).toBeNull();
  });

  it("rolls the year forward across a Dec → Jan boundary and fills multiple sea days", () => {
    const s = parse(FIXTURE_CARIBBEAN_ROLLOVER, "https://x.test/ships/symphony-2");
    expect(s.departure_date).toBe("2026-12-28");
    expect(s.return_date).toBe("2027-01-04");
    expect(s.region).toBe("Caribbean");
    expect(s.starting_price_usd).toBe(1249);
    // CocoCay is 01 Jan — must be 2027, not 2026.
    const cococay = s.itinerary.find((d) => d.port_name === "CocoCay, Bahamas");
    expect(cococay?.date).toBe("2027-01-01");
    // 29 Dec, 31 Dec, 02 Jan are gaps → at sea.
    const seaDates = s.itinerary.filter((d) => d.port_name === null).map((d) => d.date);
    expect(seaDates).toEqual(["2026-12-29", "2026-12-31", "2027-01-02"]);
  });

  it("returns null when the current-itinerary table is absent (layout drift)", () => {
    const noTable = `<html><body><h1>Some Ship</h1><h3 id="current_cruise">x</h3><p>begins on May 1, 2026 and ends on May 8, 2026</p></body></html>`;
    expect(parseSailingPage(noTable, "https://x.test/y")).toBeNull();
  });

  it("returns null when the begin-date prose anchor is missing (no year to resolve)", () => {
    const noProse = FIXTURE_ALASKA.replace(/The itinerary begins on[^<]*<strong>May 30, 2026<\/strong> and ends on <strong>June 6, 2026<\/strong>\./, "");
    expect(parseSailingPage(noProse, "https://x.test/y")).toBeNull();
  });

  it("returns null when there is no h1 ship name", () => {
    expect(parseSailingPage("<html><body><p>nope</p></body></html>", "https://x.test/y")).toBeNull();
  });

  it("produces byte-deterministic text for the same input (content-hash idempotency)", () => {
    const a = parse(FIXTURE_ALASKA, "https://x.test/y").text;
    const b = parse(FIXTURE_ALASKA, "https://x.test/y").text;
    expect(a).toBe(b);
  });
});
