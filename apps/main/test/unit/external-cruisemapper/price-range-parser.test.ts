// §33.4 D-088 — CruiseMapper price-range parser tests.

import { describe, expect, it } from "vitest";
import { parsePriceRanges } from "../../../src/lib/external/cruisemapper/parsers/price-range-parser";

const URL = "https://cruisemapper.com/ships/symphony-of-the-seas-1234";

describe("parsePriceRanges — Pattern A (table)", () => {
  it("extracts a single cabin × duration row", () => {
    const html = `
      <table class="prices">
        <caption>7-night Caribbean</caption>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 - $3,500</td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePriceRanges(html, URL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cabin_class: "balcony",
      duration_nights: 7,
      low_amount: 1200,
      high_amount: 3500,
      source_url: URL,
    });
  });

  it("classifies cabin labels correctly", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Interior</td><td>$500 - $900 (7 nights)</td></tr>
          <tr><td>Oceanview</td><td>$700 - $1,400 (7 nights)</td></tr>
          <tr><td>Balcony</td><td>$1,200 - $2,800 (7 nights)</td></tr>
          <tr><td>Mini-Suite</td><td>$2,000 - $4,500 (7 nights)</td></tr>
          <tr><td>Owner's Suite</td><td>$5,000 - $12,000 (7 nights)</td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePriceRanges(html, URL);
    const classes = rows.map((r) => r.cabin_class).sort();
    expect(classes).toEqual(["balcony", "interior", "mini_suite", "oceanview", "suite"]);
  });

  it("skips rows with no recognizable cabin label", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Crew quarters</td><td>$100 - $200 (7-night)</td></tr>
          <tr><td>Balcony</td><td>$1,000 - $2,000 (7-night)</td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePriceRanges(html, URL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cabin_class).toBe("balcony");
  });

  it("rejects rows where high < low", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$3,000 - $1,500 (7-night)</td></tr>
        </tbody>
      </table>
    `;
    expect(parsePriceRanges(html, URL)).toHaveLength(0);
  });

  it("rejects rows missing duration", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 - $3,500</td></tr>
        </tbody>
      </table>
    `;
    expect(parsePriceRanges(html, URL)).toHaveLength(0);
  });
});

describe("parsePriceRanges — Pattern B (list)", () => {
  it("extracts from ul.pricing list", () => {
    const html = `
      <ul class="pricing">
        <li>
          <span class="cabin-type">Balcony</span>
          <span class="range">$1,500 - $4,000</span>
          <span class="duration">7-night</span>
        </li>
      </ul>
    `;
    const rows = parsePriceRanges(html, URL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cabin_class: "balcony",
      duration_nights: 7,
      low_amount: 1500,
      high_amount: 4000,
    });
  });
});

describe("parsePriceRanges — edge cases", () => {
  it("returns empty array when HTML has no price widget", () => {
    const html = `<html><body><h1>Symphony of the Seas</h1></body></html>`;
    expect(parsePriceRanges(html, URL)).toEqual([]);
  });

  it("handles unicode dashes (em-dash, en-dash)", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 — $2,800 (7-night)</td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePriceRanges(html, URL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.high_amount).toBe(2800);
  });

  it("de-duplicates same (cabin_class, duration) from both patterns", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 - $3,000 (7-night)</td></tr>
        </tbody>
      </table>
      <ul class="pricing">
        <li>
          <span class="cabin-type">Balcony</span>
          <span class="range">$1,500 - $4,000</span>
          <span class="duration">7-night</span>
        </li>
      </ul>
    `;
    const rows = parsePriceRanges(html, URL);
    // Same (balcony, 7-night) appears in both — keep first (Pattern A).
    expect(rows).toHaveLength(1);
    expect(rows[0]?.low_amount).toBe(1200);
  });

  it("keeps multiple duration variants for the same cabin", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 - $2,800 (7-night)</td></tr>
          <tr><td>Balcony</td><td>$2,400 - $5,600 (14-night)</td></tr>
        </tbody>
      </table>
    `;
    const rows = parsePriceRanges(html, URL);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.duration_nights).sort((a, b) => a - b)).toEqual([7, 14]);
  });

  it("rejects bizarre duration values (over 200 nights)", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Balcony</td><td>$1,200 - $2,800 (999-night)</td></tr>
        </tbody>
      </table>
    `;
    expect(parsePriceRanges(html, URL)).toHaveLength(0);
  });

  it("source_url is the second argument verbatim", () => {
    const html = `
      <table>
        <thead><tr><th>Cabin</th><th>Price</th></tr></thead>
        <tbody>
          <tr><td>Interior</td><td>$400 - $600 (7-night)</td></tr>
        </tbody>
      </table>
    `;
    const customUrl = "https://example.com/different-ship-page";
    const rows = parsePriceRanges(html, customUrl);
    expect(rows[0]?.source_url).toBe(customUrl);
  });
});
