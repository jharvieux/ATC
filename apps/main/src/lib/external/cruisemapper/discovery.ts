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

const SHIP_INDEX_PATH = "/ships";
const PORT_INDEX_PATH = "/ports";

function baseUrl(): string {
  return (process.env.CRUISEMAPPER_DIY_BASE_URL ?? "https://www.cruisemapper.com").replace(/\/$/, "");
}

function extractDetailUrls(html: string, base: string, pathPrefix: string): string[] {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try { abs = new URL(href, base).toString(); } catch { return; }
    const u = new URL(abs);
    if (u.host !== new URL(base).host) return;
    if (!u.pathname.startsWith(pathPrefix)) return;
    // Skip the index page itself.
    if (u.pathname === pathPrefix || u.pathname === `${pathPrefix}/`) return;
    // Strip fragment + querystring for canonical inventory keys.
    u.hash = "";
    u.search = "";
    urls.add(u.toString());
  });
  return [...urls];
}

export async function discoverShipUrls(db: SupabaseClient): Promise<string[]> {
  const indexUrl = `${baseUrl()}${SHIP_INDEX_PATH}`;
  const res = await fetchCruiseMapperPage(indexUrl);
  if (res.status !== "ok") {
    console.warn(`[cm-diy] ship index fetch failed: ${res.status}`);
    return await loadInventoryByKind(db, "ship");
  }
  const fresh = extractDetailUrls(res.body, baseUrl(), "/ships");
  await upsertInventory(db, fresh, "ship");
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
 * the inventory and extracting links whose paths look like deck plans
 * (e.g., `/ships/<slug>/deck-09`). Subject to the rate limiter and
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

function extractDeckPlanLinks(html: string, shipUrl: string): string[] {
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
    // Match /<...>/deck-NN segments only.
    if (!/\/deck-\d+(?:[\/.]|$)/i.test(u.pathname)) return;
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
