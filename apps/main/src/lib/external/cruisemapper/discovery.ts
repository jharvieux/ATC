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

// CruiseMapper region pages for every region our supported lines sail. The
// mainstream lines cover the warm-weather / Europe / Alaska regions; the
// premium/luxury + expedition arms (Silversea, Seabourn, Regent, Oceania,
// Viking, Cunard, Celebrity's Galápagos ships) reach Antarctica, the Arctic,
// Galápagos, Africa / Indian Ocean, and up the ocean-navigable Amazon. Only the
// inland-river regions are excluded — no ocean ship sails the Rhine / Danube /
// Mekong / Yangtze / Nile / Mississippi / Seine / Volga, which are river-cruise
// territory (we don't cover river lines). Slug-ids confirmed live 2026-06-05.
const PORT_REGION_PAGES = [
  "/ports-in-bahamas-and-caribbean-and-bermuda-8",
  "/ports-in-hawaii-and-mexico-and-panama-canal-7",
  "/ports-in-east-coast-usa-and-canada-new-england-6",
  "/ports-in-west-coast-usa-and-canada-5",
  "/ports-in-alaska-22",
  "/ports-in-mediterranean-and-black-sea-4",
  "/ports-in-baltic-and-norwegian-fjords-and-russia-2",
  "/ports-in-western-europe-and-azores-and-canary-islands-23",
  "/ports-in-iceland-and-greenland-and-faroe-islands-1",
  "/ports-in-ireland-and-uk-and-british-isles-20",
  "/ports-in-south-america-9",
  "/ports-in-australia-and-new-zealand-and-pacific-ocean-islands-13",
  "/ports-in-asia-11",
  "/ports-in-africa-and-indian-ocean-islands-12",
  "/ports-in-arctic-and-antarctica-10",
  "/ports-in-galapagos-islands-21",
  "/ports-in-amazon-river-18",
];

// Regions hold more ports than a line holds ships — allow more fetch pages.
const MAX_PORT_PAGES_PER_REGION = 15;

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

// Walk a set of paginated index pages (cruise-line fleets or port regions),
// following ?page=N until a page adds no new detail URLs. Returns the deduped
// set of detail URLs extracted by `extract`; callers own persistence and the
// fall-back to existing inventory when nothing is discovered.
async function discoverPaginated(
  sourcePaths: readonly string[],
  maxPages: number,
  extract: (html: string, base: string) => string[],
): Promise<string[]> {
  const base = baseUrl();
  const found = new Set<string>();
  for (const path of sourcePaths) {
    for (let page = 1; page <= maxPages; page += 1) {
      const url = `${base}${path}${page > 1 ? `?page=${page}` : ""}`;
      const res = await fetchCruiseMapperPage(url);
      if (res.status !== "ok") break;
      const before = found.size;
      for (const u of extract(res.body, base)) found.add(u);
      // Stop when a page adds nothing new — past the last page, or ?page
      // clamped back to the last page.
      if (found.size === before) break;
    }
  }
  return [...found];
}

// Discover ships by enumerating each covered cruise line's fleet.
//
// Phase 1 (#780): reads active cruise lines from the cruise_lines DB table and
// upserts discovered ships into cruise_ships with correct cruise_line_id.
// Falls back to the hardcoded CRUISE_LINE_PAGES array when the table is empty
// (first deploy before migration has run) — in that case ships are only written
// to cruisemapper_url_inventory as before.
export async function discoverShipUrls(db: SupabaseClient): Promise<string[]> {
  const { data: catalogLines, error: linesErr } = await db
    .from("cruise_lines")
    .select("id, cruisemapper_slug")
    .eq("is_active", true);

  if (linesErr) {
    console.warn("discoverShipUrls: cruise_lines query failed, falling back to hardcoded list", linesErr.message);
  }

  if (!linesErr && catalogLines && catalogLines.length > 0) {
    const allShipUrls: string[] = [];
    for (const line of catalogLines as Array<{ id: string; cruisemapper_slug: string }>) {
      const lineShipUrls = await discoverPaginated(
        [`/cruise-lines/${line.cruisemapper_slug}`],
        MAX_FLEET_PAGES_PER_LINE,
        extractFleetShipUrls,
      );
      if (lineShipUrls.length > 0) {
        await upsertInventory(db, lineShipUrls, "ship");
        for (const url of lineShipUrls) {
          await upsertCruiseShipFromUrl(db, line.id, url);
        }
        allShipUrls.push(...lineShipUrls);
      }
    }
    return await loadInventoryByKind(db, "ship");
  }

  // Fallback: hardcoded list (cruise_lines table not yet populated or DB error).
  const fresh = await discoverPaginated(CRUISE_LINE_PAGES, MAX_FLEET_PAGES_PER_LINE, extractFleetShipUrls);
  if (fresh.length > 0) await upsertInventory(db, fresh, "ship");
  return await loadInventoryByKind(db, "ship");
}

// Exported so tests can verify slug + canonical_name derivation without a live DB.
// cruisemapper_slug is the last path segment (e.g. "Symphony-of-the-Seas-1").
// slug = lowercased full segment; canonical_name = name portion, title-cased.
export function deriveShipFields(url: string): { cruisemapperSlug: string; slug: string; canonicalName: string } | null {
  const cruisemapperSlug = url.split("/").pop();
  if (!cruisemapperSlug) return null;
  const slug = cruisemapperSlug.toLowerCase();
  const namePart = cruisemapperSlug.replace(/-\d+$/, "").replace(/-/g, " ");
  const canonicalName = namePart.replace(/\b\w/g, (c) => c.toUpperCase());
  return { cruisemapperSlug, slug, canonicalName };
}

async function upsertCruiseShipFromUrl(db: SupabaseClient, cruiseLineId: string, url: string): Promise<void> {
  const fields = deriveShipFields(url);
  if (!fields) return;
  const { cruisemapperSlug, slug, canonicalName } = fields;
  await safeAwait(
    db.from("cruise_ships").upsert(
      { cruise_line_id: cruiseLineId, slug, canonical_name: canonicalName, cruisemapper_slug: cruisemapperSlug },
      { onConflict: "cruisemapper_slug" },
    ),
    "cruise_ships.upsert",
  );
}

// Discover ports by enumerating each covered cruising region's port list
// (following the region page's ?page=N pagination) rather than the paginated
// global /ports index. Region pages list region-specific ports with no embedded
// global browser, so the existing /ports detail-URL filter scopes correctly.
// Falls back to existing inventory if every region page fails.
export async function discoverPortUrls(db: SupabaseClient): Promise<string[]> {
  const fresh = await discoverPaginated(
    PORT_REGION_PAGES,
    MAX_PORT_PAGES_PER_REGION,
    (html, base) => extractDetailUrls(html, base, "/ports"),
  );
  if (fresh.length > 0) await upsertInventory(db, fresh, "port");
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

// Load every inventory URL for a kind. PostgREST caps a single .select() at
// 1000 rows by default, so this MUST paginate with .range() — a non-paginated
// load silently truncated port ingest to the first 1000 URLs (issue #788).
// Exported so the sailing cron shares one paginated loader instead of keeping a
// second copy that can drift. Throws on DB error rather than masking it as an
// empty inventory.
export async function loadInventoryByKind(db: SupabaseClient, kind: "ship" | "port" | "deck_plan"): Promise<string[]> {
  const PAGE = 1000;
  const urls: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("cruisemapper_url_inventory")
      .select("url")
      .eq("kind", kind)
      .order("url", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`cruisemapper_url_inventory.select failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ url: string }>;
    for (const r of rows) urls.push(r.url);
    if (rows.length < PAGE) break;
  }
  return urls;
}
