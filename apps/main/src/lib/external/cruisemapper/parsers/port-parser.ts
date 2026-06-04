// BP36 §33.5 — CruiseMapper port detail parser.
//
// Same null-on-shape-change discipline as ship-parser. Same deterministic
// text output for RAG content-hash idempotency.

import * as cheerio from "cheerio";
import { pickSpecValue } from "./pick-spec-value";

export interface ParsedPort {
  portName: string;
  country: string | null;
  region: string | null;
  terminalInfo: string | null;
  transitNotes: string | null;
  nearbyAttractions: string[];
  portSlug: string;
  sourceUrl: string;
  text: string;
}

function paragraphAfter($: cheerio.CheerioAPI, heading: string): string | null {
  // First <p> following a heading whose text contains the keyword.
  const h = $(`h2, h3, h4`).filter((_, el) => $(el).text().toLowerCase().includes(heading.toLowerCase())).first();
  if (h.length === 0) return null;
  const p = h.nextAll("p").first().text().trim();
  return p || null;
}

function portSlugFromUrl(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return last.replace(/\.html?$/i, "");
}

export function parsePortPage(html: string, sourceUrl: string): ParsedPort | null {
  const $ = cheerio.load(html);

  const portName = $("h1").first().text().trim();
  if (!portName) return null;

  const country = pickSpecValue($, ["Country", "Nation"]);
  const region  = pickSpecValue($, ["Region", "Sea", "Cruising region"]);
  const terminalInfo = paragraphAfter($, "Terminal") ?? pickSpecValue($, ["Terminal", "Cruise terminal"]);
  const transitNotes = paragraphAfter($, "Transit") ?? paragraphAfter($, "Transport") ?? null;

  const nearbyAttractions: string[] = [];
  $(`h2, h3, h4`).filter((_, el) => $(el).text().toLowerCase().includes("attractions") || $(el).text().toLowerCase().includes("sights"))
    .first()
    .nextAll("ul").first()
    .find("li").each((_, el) => {
      const t = $(el).text().trim();
      if (t) nearbyAttractions.push(t);
    });

  // Sanity gate: name plus at least one of country/region/terminal/transit/attractions.
  const haveSomething = !!(country || region || terminalInfo || transitNotes || nearbyAttractions.length > 0);
  if (!haveSomething) return null;

  const portSlug = portSlugFromUrl(sourceUrl);

  const text = renderPortText({ portName, country, region, terminalInfo, transitNotes, nearbyAttractions });

  return { portName, country, region, terminalInfo, transitNotes, nearbyAttractions, portSlug, sourceUrl, text };
}

function renderPortText(p: { portName: string; country: string | null; region: string | null; terminalInfo: string | null; transitNotes: string | null; nearbyAttractions: string[] }): string {
  const parts: string[] = [];
  let header = `${p.portName} is a cruise port`;
  if (p.country) header += ` in ${p.country}`;
  if (p.region) header += ` (${p.region})`;
  parts.push(header + ".");
  if (p.terminalInfo) parts.push(`Terminal: ${p.terminalInfo}`);
  if (p.transitNotes) parts.push(`Transit: ${p.transitNotes}`);
  if (p.nearbyAttractions.length > 0) parts.push(`Nearby attractions: ${p.nearbyAttractions.join(", ")}.`);
  return parts.join(" ");
}
