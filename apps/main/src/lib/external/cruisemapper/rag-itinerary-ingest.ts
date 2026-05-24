// BP35 §33.4 — RAG-side client for itinerary ingest.
//
// Posts a single normalized itinerary to the RAG service's
// /api/ingest/itinerary endpoint. The endpoint is idempotent on the
// composite key + content-hash short-circuit.
//
// Auth (BP09): RS256-signed JWT via signServiceJwt, PLATFORM sentinel
// tenant (genuinely cross-tenant — itinerary data is global reference
// content read by every tenant's RAG retrieval).

import type { MappedItinerary } from "./itinerary-mapper";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

export type IngestStatus = "ingested" | "updated" | "unchanged" | "quarantined" | "error";

export interface IngestOutcome {
  status: IngestStatus;
  itinerary_id?: string;
  chunk_id?: string | null;
  reason?: string;
  httpStatus?: number;
}

export async function ingestItineraryToRag(m: MappedItinerary): Promise<IngestOutcome> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  if (!ragUrl) return { status: "error", reason: "RAG_SERVICE_URL not set" };

  let jwt: string;
  try {
    jwt = await signServiceJwt({
      tenant_id: PLATFORM_SENTINEL_TENANT_ID,
      scope: "write",
      service_identifier: "platform-admin",
    });
  } catch (err) {
    return { status: "error", reason: `jwt_sign_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const payload = {
    cruise_line: m.key.line,
    ship: m.key.ship,
    departure_date: m.key.sailDate,
    departure_port: m.key.departurePort,
    duration_nights: m.key.durationNights,
    ports_of_call: m.portsOfCall,
    region: m.region ?? undefined,
    starting_price_usd: m.startingPriceUsd ?? undefined,
    source_url: m.sourceUrl ?? undefined,
    text: m.text,
    fetched_at: new Date().toISOString(),
  };

  let res: Response;
  try {
    res = await fetch(`${ragUrl}/api/ingest/itinerary`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }

  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* tolerate empty */ }

  if (!res.ok) {
    return {
      status: "error",
      httpStatus: res.status,
      reason: typeof json.error === "string" ? json.error : `HTTP ${res.status}`,
    };
  }

  const status = (json.status as IngestStatus | undefined) ?? "error";
  const out: IngestOutcome = { status, httpStatus: res.status, chunk_id: typeof json.chunk_id === "string" ? json.chunk_id : null };
  if (typeof json.itinerary_id === "string") out.itinerary_id = json.itinerary_id;
  if (typeof json.reason === "string") out.reason = json.reason;
  return out;
}
