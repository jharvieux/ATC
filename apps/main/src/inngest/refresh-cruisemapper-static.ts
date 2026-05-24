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
// Idempotency: the deterministic source_identifier is
//   cruisemapper:ship:{slug}  /  cruisemapper:port:{slug}
// The RAG endpoint upserts by source_url within global scope; the
// inventory row's content_hash short-circuits unchanged fetches before
// they're even POSTed to RAG.

import { inngest } from "./client";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { discoverShipUrls, discoverPortUrls } from "@/lib/external/cruisemapper/discovery";
import { fetchCruiseMapperPage } from "@/lib/external/cruisemapper/diy-fetcher";
import { parseShipPage } from "@/lib/external/cruisemapper/parsers/ship-parser";
import { parsePortPage } from "@/lib/external/cruisemapper/parsers/port-parser";
import { screenForPromptInjection } from "@/lib/external/cruisemapper/prompt-injection-screen";
import { ingestReferenceToRag } from "@/lib/external/cruisemapper/rag-reference-ingest";
import type { SupabaseClient } from "@supabase/supabase-js";

const PARSE_FAILURE_HALT_RATIO = 0.05;
const MIN_SAMPLES_BEFORE_HALT = 20; // don't halt on a tiny initial sample

interface KindRunResult {
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

export const refreshCruisemapperStatic = inngest.createFunction(
  {
    id: "refresh-cruisemapper-static",
    triggers: [{ cron: "0 2 1 1,4,7,10 *" }],
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };
    if (process.env.CRUISEMAPPER_DIY_INGEST_ENABLED !== "true") {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_INGEST_ENABLED=false" };
    }
    if (!process.env.CRUISEMAPPER_DIY_USER_AGENT) {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_USER_AGENT not set" };
    }

    return withPlatformAdminAudit(
      {
        admin_user_id: "system-cron",
        reason: "external_pricing_refresh",
        operation: "refresh_cruisemapper_static",
      },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "cruisemapper_url_inventory" });

        const shipUrls = await discoverShipUrls(db);
        const portUrls = await discoverPortUrls(db);

        const ship = await processKind(db, shipUrls, "ship");
        const port = await processKind(db, portUrls, "port");

        return {
          discovered: { ship: shipUrls.length, port: portUrls.length },
          ship,
          port,
        };
      },
    );
  },
);

async function processKind(
  db: SupabaseClient,
  urls: string[],
  kind: "ship" | "port",
): Promise<KindRunResult> {
  const result: KindRunResult = {
    attempted: 0, fetched: 0, unchanged_fetch: 0, parse_failed: 0,
    injection_quarantined: 0, ingested: 0, updated: 0, unchanged_rag: 0,
    errors: 0, halted: false,
  };

  // Pre-load previous content hashes so we can pass them to the fetcher.
  const { data: prior } = await db
    .from("cruisemapper_url_inventory")
    .select("url, content_hash")
    .eq("kind", kind)
    .in("url", urls.slice(0, 5000)); // safety cap
  const priorHashByUrl = new Map<string, string>();
  for (const row of (prior ?? []) as Array<{ url: string; content_hash: string | null }>) {
    if (row.content_hash) priorHashByUrl.set(row.url, row.content_hash);
  }

  for (const url of urls) {
    result.attempted += 1;

    // Parse-failure-rate halt check, but only once we have a meaningful sample.
    if (result.attempted >= MIN_SAMPLES_BEFORE_HALT) {
      const ratio = result.parse_failed / result.attempted;
      if (ratio > PARSE_FAILURE_HALT_RATIO) {
        result.halted = true;
        result.halt_reason = `parse_failure_rate ${(ratio * 100).toFixed(1)}% > ${(PARSE_FAILURE_HALT_RATIO * 100).toFixed(0)}% after ${result.attempted} ${kind}s`;
        await sendOperatorAlert({
          severity: "high",
          signal: "cruisemapper_parser_failure_rate",
          detail: result.halt_reason,
          payload: { kind, attempted: result.attempted, failures: result.parse_failed },
        });
        break;
      }
    }

    const previousBodyHash = priorHashByUrl.get(url);
    const fetched = await fetchCruiseMapperPage(
      url,
      previousBodyHash ? { previousBodyHash } : {},
    );

    if (fetched.status === "unchanged") {
      result.unchanged_fetch += 1;
      await db.from("cruisemapper_url_inventory").update({
        last_seen_at: new Date().toISOString(),
        last_ingest_status: "unchanged",
        last_error: null,
      }).eq("url", url);
      continue;
    }

    if (fetched.status !== "ok") {
      result.errors += 1;
      await db.from("cruisemapper_url_inventory").update({
        last_seen_at: new Date().toISOString(),
        last_ingest_status: fetched.status === "robots_disallowed" ? "robots_disallowed"
          : fetched.status === "client_error" ? "client_error"
          : fetched.status === "server_error" ? "server_error"
          : "server_error",
        last_error: fetched.status,
      }).eq("url", url);
      continue;
    }

    result.fetched += 1;

    const parsed = kind === "ship"
      ? parseShipPage(fetched.body, url)
      : parsePortPage(fetched.body, url);

    if (!parsed) {
      result.parse_failed += 1;
      await db.from("cruisemapper_url_inventory").update({
        last_seen_at: new Date().toISOString(),
        last_ingest_status: "parse_failed",
        last_error: "parser_returned_null",
      }).eq("url", url);
      continue;
    }

    const injection = screenForPromptInjection(parsed.text);
    if (!injection.ok) {
      result.injection_quarantined += 1;
      await db.from("cruisemapper_url_inventory").update({
        last_seen_at: new Date().toISOString(),
        last_ingest_status: "quarantined",
        last_error: `injection_pattern: ${injection.matchedPattern}`,
      }).eq("url", url);
      continue;
    }

    let payload;
    if (kind === "ship") {
      const ship = parsed as NonNullable<ReturnType<typeof parseShipPage>>;
      payload = {
        source_identifier: `cruisemapper:ship:${ship.shipSlug}`,
        category: "ship_intel" as const,
        text: ship.text,
        source_url: url,
        source_domain: "cruisemapper.com",
        ship: ship.shipName,
        ...(ship.cruiseLine ? { cruise_line: ship.cruiseLine } : {}),
      };
    } else {
      const port = parsed as NonNullable<ReturnType<typeof parsePortPage>>;
      payload = {
        source_identifier: `cruisemapper:port:${port.portSlug}`,
        category: "port_intel" as const,
        text: port.text,
        source_url: url,
        source_domain: "cruisemapper.com",
        destination: port.portName,
      };
    }

    const outcome = await ingestReferenceToRag(payload);
    const nowIso = new Date().toISOString();
    const updateRow: Record<string, unknown> = { last_seen_at: nowIso, content_hash: fetched.bodyHash };
    switch (outcome.status) {
      case "ingested":
        result.ingested += 1;
        updateRow.last_ingest_status = "ingested";
        if (outcome.chunk_id) updateRow.related_chunk_id = outcome.chunk_id;
        break;
      case "updated":
        result.updated += 1;
        updateRow.last_ingest_status = "updated";
        if (outcome.chunk_id) updateRow.related_chunk_id = outcome.chunk_id;
        break;
      case "unchanged":
        result.unchanged_rag += 1;
        updateRow.last_ingest_status = "unchanged";
        break;
      case "quarantined":
        result.injection_quarantined += 1;
        updateRow.last_ingest_status = "quarantined";
        updateRow.last_error = outcome.reason ?? "quarantined_by_rag";
        break;
      default:
        result.errors += 1;
        updateRow.last_ingest_status = "server_error";
        updateRow.last_error = outcome.reason ?? `HTTP ${outcome.httpStatus ?? "?"}`;
    }
    await db.from("cruisemapper_url_inventory").update(updateRow).eq("url", url);
  }

  return result;
}
