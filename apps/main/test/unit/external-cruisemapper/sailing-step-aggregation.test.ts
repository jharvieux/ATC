// #770 — per-step aggregation + parse-failure halt for the monthly sailing
// refresh. Each ship page is processed in its own Inngest step, so correctness
// depends on summing per-URL sailing results and evaluating the halt on running
// totals across steps.

import { describe, expect, it } from "vitest";
import { emptySailingResult, mergeSailing } from "../../../src/lib/external/cruisemapper/sailing-ingest";
import { sailingHaltReason, runSailingWindow, sailingIngestOutcome, sailingPageOutcomeInputs, isNonCruiseSailingUrl } from "../../../src/inngest/refresh-cruisemapper-sailings";
import type { SailingUrlResult, SailingPageDeltas } from "../../../src/inngest/refresh-cruisemapper-sailings";

describe("sailing refresh — per-step aggregation", () => {
  it("mergeSailing sums every counter across ships", () => {
    const total = emptySailingResult();
    mergeSailing(total, { ...emptySailingResult(), current_parsed: 1, list_items: 40, list_ingested: 38, list_price_cache_written: 35 });
    mergeSailing(total, { ...emptySailingResult(), current_parsed: 1, no_current_sailing: 1, list_items: 10, list_errors: 10 });
    expect(total.current_parsed).toBe(2);
    expect(total.no_current_sailing).toBe(1);
    expect(total.list_items).toBe(50);
    expect(total.list_ingested).toBe(38);
    expect(total.list_errors).toBe(10);
    expect(total.list_price_cache_written).toBe(35);
  });
});

describe("sailing refresh — parse-failure halt", () => {
  it("never halts before the minimum sample size", () => {
    expect(sailingHaltReason(19, 19)).toBeNull();
  });

  it("does not halt at the sample size when within tolerance (5% is not > 5%)", () => {
    expect(sailingHaltReason(20, 1)).toBeNull();
  });

  it("halts once the sample is large enough AND the failure rate exceeds 5%", () => {
    const reason = sailingHaltReason(20, 2);
    expect(reason).not.toBeNull();
    expect(reason).toContain("sailing parse_failure_rate");
    expect(reason).toContain("20 pages");
  });

  it("unchanged-heavy runs don't trip the halt — unchanged/error pages count toward attempted, not failures", () => {
    // 100 attempted, only 1 real parse failure → 1%, well under 5%.
    expect(sailingHaltReason(100, 1)).toBeNull();
  });
});

describe("runSailingWindow — time-budgeted stepping (#796)", () => {
  function fakeResult(over: Partial<SailingUrlResult> = {}): SailingUrlResult {
    return { sailing: emptySailingResult(), fetch_unchanged: 0, fetch_errors: 0, parse_failed: 0, ...over };
  }

  it("processes all ships from the start when the budget isn't exhausted", async () => {
    const urls = ["a", "b", "c", "d"];
    const processed: string[] = [];
    const r = await runSailingWindow(
      urls,
      0,
      10_000,
      async (url) => {
        processed.push(url);
        return fakeResult({ sailing: { ...emptySailingResult(), current_ingested: 1 } });
      },
      () => 1000, // clock never advances → deadline never reached
    );
    expect(processed).toEqual(["a", "b", "c", "d"]);
    expect(r.nextIndex).toBe(4);
    expect(r.attempted).toBe(4);
    expect(r.sailing.current_ingested).toBe(4);
  });

  it("stops once the budget is spent but always advances at least one ship", async () => {
    const urls = ["a", "b", "c"];
    let t = 1000;
    const processed: string[] = [];
    const r = await runSailingWindow(
      urls,
      0,
      50,
      async (url) => {
        processed.push(url);
        t += 60; // each ship alone overruns the 50ms budget
        return fakeResult();
      },
      () => t,
    );
    expect(processed).toEqual(["a"]);
    expect(r.attempted).toBe(1);
    expect(r.nextIndex).toBe(1); // resume cursor advanced past the one processed
  });

  it("resumes from a non-zero cursor", async () => {
    const urls = ["a", "b", "c", "d"];
    const processed: string[] = [];
    const r = await runSailingWindow(urls, 2, 10_000, async (url) => {
      processed.push(url);
      return fakeResult();
    }, () => 0);
    expect(processed).toEqual(["c", "d"]);
    expect(r.nextIndex).toBe(4);
    expect(r.attempted).toBe(2);
  });

  it("aggregates per-ship counters across the window", async () => {
    const r = await runSailingWindow(
      ["a", "b"],
      0,
      10_000,
      async () => fakeResult({ fetch_unchanged: 1, parse_failed: 1, sailing: { ...emptySailingResult(), list_ingested: 5 } }),
      () => 0,
    );
    expect(r.fetch_unchanged).toBe(2);
    expect(r.parse_failed).toBe(2);
    expect(r.sailing.list_ingested).toBe(10);
  });

  it("continues past a ship whose processing THROWS, counting it as a fetch_error (#842)", async () => {
    const processed: string[] = [];
    const r = await runSailingWindow(
      ["a", "b", "c"],
      0,
      10_000,
      async (url) => {
        processed.push(url);
        if (url === "b") throw new Error("transient pooler error");
        return fakeResult({ sailing: { ...emptySailingResult(), current_ingested: 1 } });
      },
      () => 0,
    );
    expect(processed).toEqual(["a", "b", "c"]); // did NOT stop at the throw
    expect(r.attempted).toBe(3);
    expect(r.fetch_errors).toBe(1); // the throwing ship is counted, not fatal
    expect(r.parse_failed).toBe(0); // a transient throw is not a parse failure
    expect(r.sailing.current_ingested).toBe(2); // a + c still succeeded
    expect(r.nextIndex).toBe(3);
  });
});

describe("sailing refresh — sailingIngestOutcome (content_hash only when the itinerary reaches RAG)", () => {
  it("stamps content_hash when the page parsed AND landed in RAG", () => {
    const { update, parse_failed } = sailingIngestOutcome(true, true, "HASH");
    expect(update.content_hash).toBe("HASH");
    expect(update.last_ingest_status).toBe("ingested");
    expect(parse_failed).toBe(0);
  });

  it("does NOT stamp content_hash when parsed but the RAG ingest failed — the 2026-06-06 gap that masked 117 ships", () => {
    // The bug: a RAG outage left the page parsed-but-not-in-RAG, yet the old
    // code stamped the hash anyway, so the conditional GET skipped it forever.
    const { update, parse_failed } = sailingIngestOutcome(true, false, "HASH");
    expect(update.content_hash).toBeUndefined();
    expect(update.last_ingest_status).toBe("ingest_failed");
    // A RAG outage is not a parser failure, so it must not feed the parse-failure halt.
    expect(parse_failed).toBe(0);
  });

  it("marks parse_failed without a content_hash when the page didn't parse", () => {
    const { update, parse_failed } = sailingIngestOutcome(false, false, "HASH");
    expect(update.content_hash).toBeUndefined();
    expect(update.last_ingest_status).toBe("parse_failed");
    expect(parse_failed).toBe(1);
  });
});

describe("sailingPageOutcomeInputs — valid-ship + landed gating (#827 f/u)", () => {
  function deltas(over: Partial<SailingPageDeltas> = {}): SailingPageDeltas {
    return {
      hadCurrent: false,
      noCurrentButValidShip: false,
      currentLanded: false,
      listLanded: false,
      listSkippedEnriched: false,
      listHadItems: false,
      ...over,
    };
  }

  it("current sailing that landed → valid + landed (stamp hash)", () => {
    expect(sailingPageOutcomeInputs(deltas({ hadCurrent: true, currentLanded: true, listLanded: true })))
      .toEqual({ validShipPage: true, landedInRag: true });
  });

  it("current sailing that did NOT land → valid but not landed (RAG-outage retry preserved)", () => {
    // Even if the list landed, a current sailing that missed RAG must not stamp.
    expect(sailingPageOutcomeInputs(deltas({ hadCurrent: true, currentLanded: false, listLanded: true })))
      .toEqual({ validShipPage: true, landedInRag: false });
  });

  it("no current sailing + list landed → valid + landed", () => {
    expect(sailingPageOutcomeInputs(deltas({ noCurrentButValidShip: true, listHadItems: true, listLanded: true })))
      .toEqual({ validShipPage: true, landedInRag: true });
  });

  it("no current sailing + ALL list items already-enriched (skipped) → valid + landed (the audit fix: don't re-fetch forever)", () => {
    expect(sailingPageOutcomeInputs(deltas({ noCurrentButValidShip: true, listHadItems: true, listSkippedEnriched: true, listLanded: false })))
      .toEqual({ validShipPage: true, landedInRag: true });
  });

  it("no current sailing + no upcoming list at all → valid + landed (valid empty future ship, stamp + skip next run)", () => {
    expect(sailingPageOutcomeInputs(deltas({ noCurrentButValidShip: true, listHadItems: false })))
      .toEqual({ validShipPage: true, landedInRag: true });
  });

  it("no current sailing + list items that all FAILED to land → valid but not landed (retry, never a false unchanged)", () => {
    expect(sailingPageOutcomeInputs(deltas({ noCurrentButValidShip: true, listHadItems: true, listLanded: false, listSkippedEnriched: false })))
      .toEqual({ validShipPage: true, landedInRag: false });
  });

  it("unrecognizable page (no current, not a valid ship) → not valid (→ parse_failed, feeds the halt)", () => {
    expect(sailingPageOutcomeInputs(deltas({})).validShipPage).toBe(false);
  });
});

describe("isNonCruiseSailingUrl — skip ferries from sailing ingest (#819)", () => {
  it("flags ferry pages CruiseMapper lists alongside cruise ships", () => {
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Stena-Estrid-ferry-2159")).toBe(true);
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Superfast-XI-ferry-2066")).toBe(true);
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Havila-Pollux-ferry-2176")).toBe(true);
  });

  it("does not flag ocean cruise ships, nor a non-delimited 'ferry' substring", () => {
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Carnival-Vista-1039")).toBe(false);
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Symphony-Of-The-Seas-1730")).toBe(false);
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Viking-Star-974")).toBe(false);
    // Boundary: only the hyphen-delimited "-ferry-" token matches, not a substring.
    expect(isNonCruiseSailingUrl("https://www.cruisemapper.com/ships/Ferryland-Explorer-9999")).toBe(false);
  });
});
