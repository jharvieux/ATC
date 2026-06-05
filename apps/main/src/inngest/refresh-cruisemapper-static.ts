// BP36 §33.5 — Quarterly CruiseMapper DIY static refresh.
//
// Cron: 02:00 UTC on the 1st of January, April, July, October.
//
// Flow:
//   1. Kill switch: CRUISEMAPPER_DIY_INGEST_ENABLED + CRUISEMAPPER_DIY_USER_AGENT.
//   2. Discover ship + port URLs (subject to rate limit + robots.txt).
//   3. For each URL: fetch (change-detect via inventory.content_hash) → parse → screen → RAG ingest.
//   4. Per-kind: if parse failure rate > 5%, halt the run and alert (parser likely broken).
//
// Sailing ingest is NOT done here — it runs every month in
// refresh-cruisemapper-sailings (#485 / #770). This job covers ship intel +
// price ranges + ports + deck plans only.
//
// Durability (#770): every URL is processed in its own Inngest step.run, so no
// single Vercel invocation accumulates the whole job's runtime. The in-process
// token bucket can't pace fetches across separate step invocations, so external
// fetches are paced with step.sleep instead. The parse-failure halt is
// evaluated on the running per-kind totals across steps.
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
// ~1 req/sec pacing between external fetches, matching the prior token bucket.
const FETCH_PACING = "1s";

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
    // The per-URL steps below run in separate invocations and use a plain
    // service-role client, so wrapping each in withPlatformAdminAudit would emit
    // one audit_log row per URL instead of one per run.
    await step.run("audit-run", () =>
      withPlatformAdminAudit(AUDIT_META, async (_db, recordQuery) => {
        recordQuery({ op: "select", table: "cruisemapper_url_inventory" });
        return { audited: true };
      }),
    );

    const shipUrls = await step.run("discover-ships", () => discoverShipUrls(createServiceRoleClient()));

    // Ships first — ship intel + price ranges.
    const ship = emptyKindResult();
    for (let i = 0; i < shipUrls.length; i++) {
      const url = shipUrls[i]!;
      await step.sleep(`pace-ship-${i}`, FETCH_PACING);
      const r = await step.run(`ship-${i}`, () => processOneShip(createServiceRoleClient(), url));
      mergeKind(ship, r);
      const reason = haltReason(ship, "ship");
      if (reason) {
        ship.halted = true;
        ship.halt_reason = reason;
        await step.run(`halt-ship-${i}`, () => alertHalt("ship", ship));
        break;
      }
    }

    const portUrls = await step.run("discover-ports", () => discoverPortUrls(createServiceRoleClient()));

    const port = emptyKindResult();
    for (let i = 0; i < portUrls.length; i++) {
      const url = portUrls[i]!;
      await step.sleep(`pace-port-${i}`, FETCH_PACING);
      const r = await step.run(`port-${i}`, () => processOneUrl(createServiceRoleClient(), url, "port"));
      mergeKind(port, r);
      const reason = haltReason(port, "port");
      if (reason) {
        port.halted = true;
        port.halt_reason = reason;
        await step.run(`halt-port-${i}`, () => alertHalt("port", port));
        break;
      }
    }

    // BP37: deck discovery must happen AFTER ships are in inventory so deck
    // links can be enumerated per ship. One step — its internal re-fetches are
    // token-bucket-paced within the single invocation.
    const deckUrls = await step.run("discover-decks", () => discoverDeckPlanUrls(createServiceRoleClient()));

    const deck = emptyKindResult();
    for (let i = 0; i < deckUrls.length; i++) {
      const url = deckUrls[i]!;
      await step.sleep(`pace-deck-${i}`, FETCH_PACING);
      const r = await step.run(`deck-${i}`, () => processOneUrl(createServiceRoleClient(), url, "deck_plan"));
      mergeKind(deck, r);
      const reason = haltReason(deck, "deck_plan");
      if (reason) {
        deck.halted = true;
        deck.halt_reason = reason;
        await step.run(`halt-deck-${i}`, () => alertHalt("deck_plan", deck));
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

// Apply a RAG reference-ingest outcome to the per-URL result counters and the
// inventory row (records content_hash so the next run can change-detect).
async function finalizeIngest(
  result: KindRunResult,
  outcome: Awaited<ReturnType<typeof ingestReferenceToRag>>,
  db: SupabaseClient,
  url: string,
  bodyHash: string,
): Promise<void> {
  const updateRow: Record<string, unknown> = { last_seen_at: new Date().toISOString(), content_hash: bodyHash };
  switch (outcome.status) {
    case "ingested":
      result.ingested = 1;
      updateRow.last_ingest_status = "ingested";
      if (outcome.chunk_id) updateRow.related_chunk_id = outcome.chunk_id;
      break;
    case "updated":
      result.updated = 1;
      updateRow.last_ingest_status = "updated";
      if (outcome.chunk_id) updateRow.related_chunk_id = outcome.chunk_id;
      break;
    case "unchanged":
      result.unchanged_rag = 1;
      updateRow.last_ingest_status = "unchanged";
      break;
    case "quarantined":
      result.injection_quarantined = 1;
      updateRow.last_ingest_status = "quarantined";
      updateRow.last_error = outcome.reason ?? "quarantined_by_rag";
      break;
    default:
      result.errors = 1;
      updateRow.last_ingest_status = "server_error";
      updateRow.last_error = outcome.reason ?? `HTTP ${outcome.httpStatus ?? "?"}`;
  }
  await safeAwait(db.from("cruisemapper_url_inventory").update(updateRow).eq("url", url), "cruisemapper_url_inventory.update");
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

  const parsed = kind === "port" ? parsePortPage(fetched.body, url) : parseDeckPlanPage(fetched.body, url);
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
