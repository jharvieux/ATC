// Issue #694 — Shared label-value lookup for the ship + port detail parsers.
//
// CruiseMapper's detail pages use FIVE different markup patterns for the
// "Label: Value" rows that contain spec data. Previously the ship and
// port parsers each carried their own pickSpecValue that only handled the
// first three; CruiseMapper's June 2026 layout moved most fields into D
// and E and broke both parsers (100% parse failure observed in prod).
//
// Patterns supported:
//   A. <th>Label</th><td>value</td>            (header-row tables)
//   B. <dt>Label</dt><dd>value</dd>            (description lists)
//   C. <li><span class="label">Label</span><span>value</span></li>
//   D. <span class="infoLabel">Label</span>... (info card; value is sibling/parent text)
//   E. <tr><td>Label</td><td>value</td></tr>   (label cell + value cell, both <td>)
//
// `:contains` is substring-y; for D/E we use an exact-text filter so a
// label like "Class" doesn't accidentally pick up "Ship classification".

import type * as cheerio from "cheerio";

function textEqualsLabel(text: string, label: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  const target = label.toLowerCase();
  // Tolerate a trailing colon ("Class:" should match "Class").
  return lower === target || lower === `${target}:`;
}

export function pickSpecValue($: cheerio.CheerioAPI, labels: string[]): string | null {
  // All patterns require EXACT text match on the label cell. The historical
  // `:contains` substring match here was the root cause of issue #694: on a
  // real page, "Class" matched a nav <li> containing "All-class fleet" before
  // it reached the real <td>Class</td> spec row.
  for (const label of labels) {
    // Pattern A: <th>Label</th><td>value</td>
    const aEl = $("th").filter((_, el) => textEqualsLabel($(el).text(), label)).first();
    if (aEl.length > 0) {
      const a = aEl.next("td").text().replace(/\s+/g, " ").trim();
      if (a) return a;
    }

    // Pattern B: <dt>Label</dt><dd>value</dd>
    const bEl = $("dt").filter((_, el) => textEqualsLabel($(el).text(), label)).first();
    if (bEl.length > 0) {
      const b = bEl.next("dd").text().replace(/\s+/g, " ").trim();
      if (b) return b;
    }

    // Pattern C: <li><span class="label">Label</span><span>value</span></li>
    const cEl = $("li > span.label, li > span.spec-label").filter((_, el) => textEqualsLabel($(el).text(), label)).first();
    if (cEl.length > 0) {
      const c = cEl.parent().find("span").last().text().replace(/\s+/g, " ").trim();
      if (c && c.toLowerCase() !== label.toLowerCase()) return c;
    }

    // Pattern D: <p class="row"><span class="infoLabel">[icon] Label</span><br>value</p>
    // The label span may contain a leading icon (<i class="fa ...">); compare
    // on rendered text only. The value is whatever's in the parent element
    // after removing the label span and any <br>.
    const dEl = $("span.infoLabel").filter((_, el) => textEqualsLabel($(el).text(), label)).first();
    if (dEl.length > 0) {
      const parent = dEl.parent();
      if (parent.length > 0) {
        const clone = parent.clone();
        clone.find("span.infoLabel, br").remove();
        const d = clone.text().replace(/\s+/g, " ").trim();
        if (d) return d;
      }
    }

    // Pattern E: <tr><td>Label</td><td>value</td></tr>
    // The CruiseMapper June 2026 layout uses <td> for BOTH label and value
    // (the table has no <th>), so Pattern A misses these. Exact-text match
    // on the label cell to avoid matching itinerary date/port cells.
    const eEl = $("td").filter((_, el) => textEqualsLabel($(el).text(), label)).first();
    if (eEl.length > 0) {
      const e = eEl.next("td").text().replace(/\s+/g, " ").trim();
      if (e) return e;
    }
  }
  return null;
}
