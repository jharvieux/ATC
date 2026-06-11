// BP36 §33.5 — Quarterly CruiseMapper DIY static refresh.
//
// Cron: 02:00 UTC on the 1st of January, April, July, October.
//
// Flow:
//   1. Kill switch: CRUISEMAPPER_DIY_INGEST_ENABLED + CRUISEMAPPER_DIY_USER_AGENT.
//   2. Discover ship (per cruise-line fleet) + port URLs.
//   3. For each URL: fetch (change-detect via inventory.content_hash) → parse → screen → RAG ingest.
//   4. Per-kind: if parse failure rate > 5%, halt the run and alert (parser likely broken).
//
// Sailing ingest is NOT done here — it runs every month in
// refresh-cruisemapper-sailings (#485 / #770). This job covers ship intel +
// price ranges + ports + deck plans only.
//
// Durability (#770): URLs are processed in BATCHES, each batch its own Inngest
// step.run, so no single Vercel invocation accumulates the whole job's runtime
// and the total step count stays bounded as the fleet grows (~215 ships across
// the covered cruise lines). External fetches are paced by the in-process token
// bucket within each batch invocation.
//
// Idempotency: the deterministic source_identifier is
//   cruisemapper:ship:{slug} / cruisemapper:port:{slug} / cruisemapper:deck:{slug}
// The RAG endpoint upserts by source_url within global scope and the inventory
// row's content_hash short-circuits unchanged fetches, so re-running any step
// is safe — Inngest's automatic step retries can't double-write.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { discoverShipUrls, discoverPortUrls, discoverDeckPlanUrls } from "@/lib/external/cruisemapper/discovery";
import { fetchCruiseMapperPage } from "@/lib/external/cruisemapper/diy-fetcher";
import { parseShipPage } from "@/lib/external/cruisemapper/parsers/ship-parser";
import { parsePortPage } from "@/lib/external/cruisemapper/parsers/port-parser";
import { parseDeckPlanPage } from "@/lib/external/cruisemapper/parsers/deck-parser";
// D-088 — DIY price-range extraction (replaces Apify general-pricing path).
import { parsePriceRanges } from "@/lib/external/cruisemapper/parsers/price-range-parser";
import { upsertGeneralPriceRange } from "@/lib/pricing/general-pricing-ranges";
import { screenForPromptInjection } from "@/lib/external/cruisemapper/prompt-injection-screen";
import { ingestReferenceToRag } from "@/lib/external/cruisemapper/rag-reference-ingest";
import { recordDeckPlanImage } from "@/lib/external/cruisemapper/image-asset-recorder";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

const PARSE_FAILURE_HALT_RATIO = 0.05;
const MIN_SAMPLES_BEFORE_HALT = 20; // don't halt on a tiny initial sample
// Per-step batch sizes. Each batch's external fetches are paced by the
// in-process token bucket within its single step invocation; batching keeps the
// total Inngest step count bounded as the fleet grows (~215 ships).
const SHIP_CHUNK = 10; // ship intel + price ranges — light per URL
const PORT_CHUNK = 10; // 1 fetch + 1 RAG ingest — light
const DECK_CHUNK = 8;  // fetch + several image records + 1 RAG ingest

export interface KindRunResult {
  attempted: number;
  fetched: number;
  unchanged_fetch: number;
  parse_failed: number;
  injection_quarantined: number;
  ingested: number;
  updated: number;
  unchanged_rag: number;
  errors: number;
  halted: boolean;
  halt_reason?: string;
}

export function emptyKindResult(): KindRunResult {
  return {
    attempted: 0, fetched: 0, unchanged_fetch: 0, parse_failed: 0,
    injection_quarantined: 0, ingested: 0, updated: 0, unchanged_rag: 0,
    errors: 0, halted: false,
  };
}

export function mergeKind(into: KindRunResult, one: KindRunResult): void {
  into.attempted += one.attempted;
  into.fetched += one.fetched;
  into.unchanged_fetch += one.unchanged_fetch;
  into.parse_failed += one.parse_failed;
  into.injection_quarantined += one.injection_quarantined;
  into.ingested += one.ingested;
  into.updated += one.updated;
  into.unchanged_rag += one.unchanged_rag;
  into.errors += one.errors;
}

// Parse-failure circuit breaker on the running per-kind totals: once we have a
// meaningful sample, halt the kind if the parser is failing too often (it's
// probably broken, and we don't want to keep hammering the source).
export function haltReason(totals: KindRunResult, kind: string): string | null {
  if (totals.attempted < MIN_SAMPLES_BEFORE_HALT) return null;
  const ratio = totals.parse_failed / totals.attempted;
  if (ratio <= PARSE_FAILURE_HALT_RATIO) return null;
  return `parse_failure_rate ${(ratio * 100).toFixed(1)}% > ${(PARSE_FAILURE_HALT_RATIO * 100).toFixed(0)}% after ${totals.attempted} ${kind}s`;
}

const AUDIT_META = {
  admin_user_id: "system-cron",
  reason: "external_pricing_refresh",
  operation: "refresh_cruisemapper_static",
} as const;

export const refreshCruisemapperStatic = inngest.createFunction(
  {
    id: "refresh-cruisemapper-static",
    triggers: [{ cron: "0 2 1 1,4,7,10 *" }],
  },
  async ({ step }) => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (process.env.CRUISEMAPPER_DIY_INGEST_ENABLED !== "true") {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_INGEST_ENABLED=false" };
    }
    if (!process.env.CRUISEMAPPER_DIY_USER_AGENT) {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_USER_AGENT not set" };
    }

    // One platform-admin audit row per run (the prior single-wrapper behaviour).
    // The batch steps below run in separate invocations and use a plain
    // service-role client, so wrapping each in withPlatformAdminAudit would emit
    // one audit_log row per batch instead of one per run.
    await step.run("audit-run", () =>
      withPlatformAdminAudit(AUDIT_META, async (_db, recordQuery) => {
        recordQuery({ op: "select", table: "cruisemapper_url_inventory" });
        return { audited: true };
      }),
    );

    const shipUrls = await step.run("discover-ships", () => discoverShipUrls(createServiceRoleClient()));

    // Ships first — ship intel + price ranges. Processed in batches so the step
    // count stays bounded as the fleet grows.
    const ship = emptyKindResult();
    for (let i = 0; i < shipUrls.length; i += SHIP_CHUNK) {
      const batch = shipUrls.slice(i, i + SHIP_CHUNK);
      const r = await step.run(`ships-${i / SHIP_CHUNK}`, () => processShipBatch(batch));
      mergeKind(ship, r);
      const reason = haltReason(ship, "ship");
      if (reason) {
        ship.halted = true;
        ship.halt_reason = reason;
        await step.run(`halt-ship-${i / SHIP_CHUNK}`, () => alertHalt("ship", ship));
        break;
      }
    }

    const portUrls = await step.run("discover-ports", () => discoverPortUrls(createServiceRoleClient()));

    const port = emptyKindResult();
    for (let i = 0; i < portUrls.length; i += PORT_CHUNK) {
      const batch = portUrls.slice(i, i + PORT_CHUNK);
      const r = await step.run(`ports-${i / PORT_CHUNK}`, () => processUrlBatch(batch, "port"));
      mergeKind(port, r);
      const reason = haltReason(port, "port");
      if (reason) {
        port.halted = true;
        port.halt_reason = reason;
        await step.run(`halt-port-${i / PORT_CHUNK}`, () => alertHalt("port", port));
        break;
      }
    }

    // BP37: deck discovery must happen AFTER ships are in inventory so deck
    // links can be enumerated per ship. One step — its internal re-fetches are
    // token-bucket-paced within the single invocation.
    const deckUrls = await step.run("discover-decks", () => discoverDeckPlanUrls(createServiceRoleClient()));

    const deck = emptyKindResult();
    for (let i = 0; i < deckUrls.length; i += DECK_CHUNK) {
      const batch = deckUrls.slice(i, i + DECK_CHUNK);
      const r = await step.run(`decks-${i / DECK_CHUNK}`, () => processUrlBatch(batch, "deck_plan"));
      mergeKind(deck, r);
      const reason = haltReason(deck, "deck_plan");
      if (reason) {
        deck.halted = true;
        deck.halt_reason = reason;
        await step.run(`halt-deck-${i / DECK_CHUNK}`, () => alertHalt("deck_plan", deck));
        break;
      }
    }

    return {
      discovered: { ship: shipUrls.length, port: portUrls.length, deck_plan: deckUrls.length },
      ship,
      port,
      deck,
    };
  },
);

// Process a batch of ship URLs in one step. One service-role client per batch;
// the in-process token bucket paces the external fetches within this invocation.
async function processShipBatch(urls: string[]): Promise<KindRunResult> {
  const db = createServiceRoleClient();
  const total = emptyKindResult();
  for (const url of urls) mergeKind(total, await processOneShip(db, url));
  return total;
}

async function processUrlBatch(urls: string[], kind: "port" | "deck_plan"): Promise<KindRunResult> {
  const db = createServiceRoleClient();
  const total = emptyKindResult();
  for (const url of urls) mergeKind(total, await processOneUrl(db, url, kind));
  return total;
}

async function alertHalt(kind: string, totals: KindRunResult): Promise<{ alerted: true }> {
  await sendOperatorAlert({
    severity: "high",
    signal: "cruisemapper_parser_failure_rate",
    detail: totals.halt_reason ?? `parse failure rate exceeded for ${kind}`,
    payload: { kind, attempted: totals.attempted, failures: totals.parse_failed },
  });
  return { alerted: true };
}

async function priorContentHash(db: SupabaseClient, url: string): Promise<string | undefined> {
  const { data, error } = await db
    .from("cruisemapper_url_inventory")
    .select("content_hash")
    .eq("url", url)
    .maybeSingle();
  if (error) throw new Error(`cruisemapper_url_inventory.select failed: ${error.message}`);
  return (data as { content_hash: string | null } | null)?.content_hash ?? undefined;
}

async function markInventory(db: SupabaseClient, url: string, status: string, error: string | null): Promise<void> {
  await safeAwait(db.from("cruisemapper_url_inventory").update({
    last_seen_at: new Date().toISOString(),
    last_ingest_status: status,
    last_error: error,
  }).eq("url", url), "cruisemapper_url_inventory.update");
}

// Decide the inventory row update from a RAG reference-ingest outcome.
// content_hash is stamped ONLY when the content is in RAG (ingested/updated/
// unchanged) or was definitively rejected (quarantined) — never on a transient
// server_error, so a failed ingest is retried by the next run's unconditional
// GET instead of being masked as "unchanged" (the 2026-06-06 sailing gap, same
// root cause: stamping the change-detection hash before the write is confirmed).
export function referenceIngestOutcome(
  outcome: { status: string; chunk_id?: string | null; reason?: string; httpStatus?: number },
  bodyHash: string,
): { update: Record<string, unknown>; delta: Partial<KindRunResult> } {
  const update: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  switch (outcome.status) {
    case "ingested":
      update.last_ingest_status = "ingested";
      update.content_hash = bodyHash;
      if (outcome.chunk_id) update.related_chunk_id = outcome.chunk_id;
      return { update, delta: { ingested: 1 } };
    case "updated":
      update.last_ingest_status = "updated";
      update.content_hash = bodyHash;
      if (outcome.chunk_id) update.related_chunk_id = outcome.chunk_id;
      return { update, delta: { updated: 1 } };
    case "unchanged":
      update.last_ingest_status = "unchanged";
      update.content_hash = bodyHash;
      return { update, delta: { unchanged_rag: 1 } };
    case "quarantined":
      update.last_ingest_status = "quarantined";
      update.last_error = outcome.reason ?? "quarantined_by_rag";
      update.content_hash = bodyHash;
      return { update, delta: { injection_quarantined: 1 } };
    default:
      update.last_ingest_status = "server_error";
      update.last_error = outcome.reason ?? `HTTP ${outcome.httpStatus ?? "?"}`;
      return { update, delta: { errors: 1 } };
  }
}

// Apply a RAG reference-ingest outcome to the per-URL result counters and the
// inventory row.
async function finalizeIngest(
  result: KindRunResult,
  outcome: Awaited<ReturnType<typeof ingestReferenceToRag>>,
  db: SupabaseClient,
  url: string,
  bodyHash: string,
): Promise<void> {
  const { update, delta } = referenceIngestOutcome(outcome, bodyHash);
  Object.assign(result, delta);
  await safeAwait(db.from("cruisemapper_url_inventory").update(update).eq("url", url), "cruisemapper_url_inventory.update");
}

// Process ONE port or deck-plan URL: fetch → parse → screen → RAG ingest.
async function processOneUrl(
  db: SupabaseClient,
  url: string,
  kind: "port" | "deck_plan",
): Promise<KindRunResult> {
  const result = emptyKindResult();
  result.attempted = 1;

  const previousBodyHash = await priorContentHash(db, url);
  const fetched = await fetchCruiseMapperPage(url, previousBodyHash ? { previousBodyHash } : {});

  if (fetched.status === "unchanged") {
    result.unchanged_fetch = 1;
    await markInventory(db, url, "unchanged", null);
    return result;
  }
  if (fetched.status !== "ok") {
    result.errors = 1;
    const status = fetched.status === "robots_disallowed" ? "robots_disallowed"
      : fetched.status === "client_error" ? "client_error" : "server_error";
    await markInventory(db, url, status, fetched.status);
    return result;
  }

  result.fetched = 1;

  // Deck plans use the final URL after redirects: the parser derives the ship
  // slug from sourceUrl, and CruiseMapper 301s renamed ships (e.g.
  // Pacific-Princess-589 → Azamara-Onward-589), so the deck link prefix check
  // would never match if we passed the original URL.
  const parsed = kind === "port"
    ? parsePortPage(fetched.body, url)
    : parseDeckPlanPage(fetched.body, fetched.finalUrl);
  if (!parsed) {
    result.parse_failed = 1;
    await markInventory(db, url, "parse_failed", "parser_returned_null");
    return result;
  }

  const injection = screenForPromptInjection(parsed.text);
  if (!injection.ok) {
    result.injection_quarantined = 1;
    await markInventory(db, url, "quarantined", `injection_pattern: ${injection.matchedPattern}`);
    return result;
  }

  let payload;
  if (kind === "port") {
    const portParsed = parsed as NonNullable<ReturnType<typeof parsePortPage>>;
    payload = {
      source_identifier: `cruisemapper:port:${portParsed.portSlug}`,
      category: "port_intel" as const,
      text: portParsed.text,
      source_url: url,
      source_domain: "cruisemapper.com",
      destination: portParsed.portName,
    };
  } else {
    // BP37 deck plans: one combined gallery page per ship → record each deck's
    // image as a hot-linked asset, then ingest a single per-ship chunk.
    const deckParsed = parsed as NonNullable<ReturnType<typeof parseDeckPlanPage>>;
    const assetIds: string[] = [];
    for (const img of deckParsed.images) {
      const rec = await recordDeckPlanImage({
        imageUrl: img.imageUrl,
        sourcePageUrl: url,
        shipSlug: deckParsed.shipSlug,
        deckNumber: img.deckNumber,
        caption: img.caption,
        width: img.width,
        height: img.height,
      });
      if (rec.status === "recorded" && rec.asset_id) assetIds.push(rec.asset_id);
    }
    payload = {
      source_identifier: `cruisemapper:deck:${deckParsed.shipSlug}`,
      category: "deck_intel" as const,
      text: deckParsed.text,
      source_url: url,
      source_domain: "cruisemapper.com",
      ship: deckParsed.shipName,
      related_asset_ids: assetIds,
    };
  }

  await finalizeIngest(result, await ingestReferenceToRag(payload), db, url, fetched.bodyHash);
  return result;
}

// Process ONE ship URL: ship intel + (best-effort) price ranges off the same
// fetched HTML. Price-range failures never affect the ship parse counters —
// ship intel always lands if the ship parser succeeds.
async function processOneShip(db: SupabaseClient, url: string): Promise<KindRunResult> {
  const ship = emptyKindResult();
  ship.attempted = 1;

  const previousBodyHash = await priorContentHash(db, url);
  const fetched = await fetchCruiseMapperPage(url, previousBodyHash ? { previousBodyHash } : {});

  if (fetched.status === "unchanged") {
    ship.unchanged_fetch = 1;
    await markInventory(db, url, "unchanged", null);
    return ship;
  }
  if (fetched.status !== "ok") {
    ship.errors = 1;
    const status = fetched.status === "robots_disallowed" ? "robots_disallowed"
      : fetched.status === "client_error" ? "client_error" : "server_error";
    await markInventory(db, url, status, fetched.status);
    return ship;
  }

  ship.fetched = 1;

  const parsed = parseShipPage(fetched.body, url);
  if (!parsed) {
    ship.parse_failed = 1;
    await markInventory(db, url, "parse_failed", "parser_returned_null");
    return ship;
  }

  const injection = screenForPromptInjection(parsed.text);
  if (!injection.ok) {
    ship.injection_quarantined = 1;
    await markInventory(db, url, "quarantined", `injection_pattern: ${injection.matchedPattern}`);
    return ship;
  }

  // #780 — persist ship_class into cruise_ships when available (best-effort).
  if (parsed.shipClass) {
    const cruisemapperSlug = url.split("/").pop();
    if (cruisemapperSlug) {
      await safeAwait(
        // d091-allow:service-role-tenant cruise_ships is a platform-wide reference table, no tenant_id column
        db.from("cruise_ships")
          .update({ ship_class: parsed.shipClass, updated_at: new Date().toISOString() })
          .eq("cruisemapper_slug", cruisemapperSlug)
          .is("ship_class", null),
        "cruise_ships.update.ship_class",
      );
    }
  }

  // D-088 — price ranges from the same HTML (best-effort, doesn't block ship intel).
  if (parsed.cruiseLine) {
    const ranges = parsePriceRanges(fetched.body, url);
    for (const r of ranges) {
      const upsertRes = await upsertGeneralPriceRange(db, {
        cruise_line: parsed.cruiseLine,
        ship: parsed.shipName,
        cabin_class: r.cabin_class,
        duration_nights: r.duration_nights,
        low_amount: r.low_amount,
        high_amount: r.high_amount,
        source_url: url,
      });
      if (!upsertRes.ok) {
        console.warn("[refresh-cruisemapper-static] price-range upsert failed",
          { url, cabin_class: r.cabin_class, error: upsertRes.error });
      }
    }
  }

  const payload = {
    source_identifier: `cruisemapper:ship:${parsed.shipSlug}`,
    category: "ship_intel" as const,
    text: parsed.text,
    source_url: url,
    source_domain: "cruisemapper.com",
    ship: parsed.shipName,
    ...(parsed.cruiseLine ? { cruise_line: parsed.cruiseLine } : {}),
  };
  await finalizeIngest(ship, await ingestReferenceToRag(payload), db, url, fetched.bodyHash);
  return ship;
}
