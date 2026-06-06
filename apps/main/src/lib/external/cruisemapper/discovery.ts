// BP36 §33.5 — CruiseMapper URL discovery.
//
// Scrapes the public ship + port index pages to enumerate detail URLs.
// Discovery itself is subject to the rate limiter + robots.txt check
// (via fetchCruiseMapperPage).
//
// Discovered URLs are persisted to public.cruisemapper_url_inventory so
// re-runs can do change detection. Returns the freshly-discovered set
// AND merges with previously-known URLs from inventory.

import * as cheerio from "cheerio";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCruiseMapperPage } from "./diy-fetcher";
import { safeAwait } from "@/lib/db/safe-mutation";

const PORT_INDEX_PATH = "/ports";

// CruiseMapper cruise-line pages for the lines we cover — major US-market lines
// plus the premium/luxury lines US customers book. Ship discovery enumerates
// each line's fleet from these pages, NOT the global /ships index (which is
// paginated ~38/page and dominated by river/expedition/foreign-market ships).
// Slug-ids confirmed live 2026-06-05. Viking ocean only (river excluded);
// Costa excluded (minimal US presence).
const CRUISE_LINE_PAGES = [
  "/cruise-lines/Carnival-Cruise-Line-9",
  "/cruise-lines/Royal-Caribbean-1",
  "/cruise-lines/Norwegian-Cruise-Line-10",
  "/cruise-lines/Celebrity-Cruises-5",
  "/cruise-lines/Princess-Cruises-3",
  "/cruise-lines/Holland-America-11",
  "/cruise-lines/MSC-Cruises-13",
  "/cruise-lines/Disney-Cruise-Line-12",
  "/cruise-lines/Virgin-Voyages-109",
  "/cruise-lines/Viking-Cruises-78",
  "/cruise-lines/Oceania-Cruises-29",
  "/cruise-lines/Cunard-31",
  "/cruise-lines/Azamara-Cruises-7",
  "/cruise-lines/Regent-Seven-Seas-Cruises-28",
  "/cruise-lines/Seabourn-Cruises-2",
  "/cruise-lines/Silversea-Cruises-19",
  "/cruise-lines/Windstar-Cruises-30",
];

// Each line page paginates its fleet (~15 ships/page) via ?page=N; cap the
// follow so a misbehaving "next" can't loop unbounded.
const MAX_FLEET_PAGES_PER_LINE = 8;

function baseUrl(): string {
  return (process.env.CRUISEMAPPER_DIY_BASE_URL ?? "https://www.cruisemapper.com").replace(/\/$/, "");
}

// Exported so the URL-shape filter (issue #694) can be unit-tested without
// mocking fetchCruiseMapperPage + the DB. The discover* wrappers are the
// production entry points.
export function extractDetailUrls(html: string, base: string, pathPrefix: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  // Require a path segment AFTER the prefix so we don't match sibling paths
  // like `/ports-in-arctic-and-antarctica-10` for prefix `/ports` (issue #694).
  // CruiseMapper's region-listing URLs share the `/ports` prefix but are NOT
  // valid input for the port-detail parser.
  const requiredPrefix = pathPrefix.endsWith("/") ? pathPrefix : `${pathPrefix}/`;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try { abs = new URL(href, base).toString(); } catch { return; }
    const u = new URL(abs);
    if (u.host !== new URL(base).host) return;
    if (!u.pathname.startsWith(requiredPrefix)) return;
    // Drop the bare-prefix index page itself ("/ports/" with no slug after).
    if (u.pathname === requiredPrefix) return;
    // Strip fragment + querystring for canonical inventory keys.
    u.hash = "";
    u.search = "";
    urls.add(u.toString());
  });
  return [...urls];
}

// Extract a cruise-line page's OWN fleet ship URLs. Scoped to the
// `.shipListItem` cards in the fleet list — NOT every /ships/ link on the page,
// because the page also embeds a global ship browser whose links would
// re-pull the unscoped global list (the original 38-ship coverage bug).
export function extractFleetShipUrls(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const host = new URL(base).host;
  $(".shipListItem a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try { abs = new URL(href, base).toString(); } catch { return; }
    const u = new URL(abs);
    if (u.host !== host) return;
    if (!/^\/ships\/[^/]+$/.test(u.pathname)) return; // detail page only
    u.hash = "";
    u.search = "";
    out.add(u.toString());
  });
  return [...out];
}

// Discover ships by enumerating each covered cruise line's fleet (following the
// line page's ?page=N fleet pagination) rather than the paginated global /ships
// index. Falls back to existing inventory if every line page fails.
export async function discoverShipUrls(db: SupabaseClient): Promise<string[]> {
  const base = baseUrl();
  const found = new Set<string>();
  for (const linePath of CRUISE_LINE_PAGES) {
    for (let page = 1; page <= MAX_FLEET_PAGES_PER_LINE; page += 1) {
      const url = `${base}${linePath}${page > 1 ? `?page=${page}` : ""}`;
      const res = await fetchCruiseMapperPage(url);
      if (res.status !== "ok") break;
      const before = found.size;
      for (const u of extractFleetShipUrls(res.body, base)) found.add(u);
      // Stop when a page adds no new ships — past the last fleet page, or the
      // line page clamped ?page back to the last page.
      if (found.size === before) break;
    }
  }
  if (found.size > 0) await upsertInventory(db, [...found], "ship");
  return await loadInventoryByKind(db, "ship");
}

export async function discoverPortUrls(db: SupabaseClient): Promise<string[]> {
  const indexUrl = `${baseUrl()}${PORT_INDEX_PATH}`;
  const res = await fetchCruiseMapperPage(indexUrl);
  if (res.status !== "ok") {
    console.warn(`[cm-diy] port index fetch failed: ${res.status}`);
    return await loadInventoryByKind(db, "port");
  }
  const fresh = extractDetailUrls(res.body, baseUrl(), "/ports");
  await upsertInventory(db, fresh, "port");
  return await loadInventoryByKind(db, "port");
}

/**
 * BP37 §33.5 — discover deck plan URLs by visiting every ship page in
 * the inventory and extracting the link to its combined deck-plans gallery
 * page (`/deckplans/<Ship-Slug-Id>`). Subject to the rate limiter and
 * robots.txt check via fetchCruiseMapperPage.
 *
 * Returns the full deck-plan inventory after upsert.
 */
export async function discoverDeckPlanUrls(db: SupabaseClient): Promise<string[]> {
  const shipUrls = await loadInventoryByKind(db, "ship");
  for (const shipUrl of shipUrls) {
    const res = await fetchCruiseMapperPage(shipUrl);
    if (res.status !== "ok") continue;
    const fresh = extractDeckPlanLinks(res.body, shipUrl);
    if (fresh.length > 0) {
      await upsertInventory(db, fresh, "deck_plan");
    }
  }
  return await loadInventoryByKind(db, "deck_plan");
}

// Exported so the deck-plan URL-shape filter (issue #768) can be unit-tested
// without mocking fetchCruiseMapperPage + the DB.
export function extractDeckPlanLinks(html: string, shipUrl: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  const base = baseUrl();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try { abs = new URL(href, shipUrl).toString(); } catch { return; }
    const u = new URL(abs);
    if (u.host !== new URL(base).host) return;
    // CruiseMapper deck plans live at /deckplans/<Ship-Slug-Id> — one combined
    // gallery page per ship. Match exactly that shape: the literal /deckplans/
    // prefix plus a single non-empty slug segment. Excludes the bare /deckplans
    // index and the per-deck sub-pages (/deckplans/<slug>/deckNN-id).
    if (!/^\/deckplans\/[^/]+$/i.test(u.pathname)) return;
    u.hash = "";
    u.search = "";
    out.add(u.toString());
  });
  return [...out];
}

async function upsertInventory(db: SupabaseClient, urls: string[], kind: "ship" | "port" | "deck_plan"): Promise<void> {
  if (urls.length === 0) return;
  const nowIso = new Date().toISOString();
  // Chunk by 500 to keep payloads reasonable.
  for (let i = 0; i < urls.length; i += 500) {
    const slice = urls.slice(i, i + 500);
    await safeAwait(db
      .from("cruisemapper_url_inventory")
      .upsert(
        slice.map((url) => ({ url, kind, last_seen_at: nowIso })),
        { onConflict: "url" },
      ), "cruisemapper_url_inventory.upsert");
  }
}

async function loadInventoryByKind(db: SupabaseClient, kind: "ship" | "port" | "deck_plan"): Promise<string[]> {
  const { data } = await db
    .from("cruisemapper_url_inventory")
    .select("url")
    .eq("kind", kind);
  return ((data ?? []) as Array<{ url: string }>).map((r) => r.url);
}
