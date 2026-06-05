// BP36 §33.5 — RAG-side client for reference content ingest.
//
// POSTs to /api/ingest/reference. Auth (BP09): RS256-signed JWT,
// PLATFORM sentinel tenant (genuinely cross-tenant — reference content is
// global, read by every tenant's RAG retrieval).

import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

export type RefIngestStatus = "ingested" | "updated" | "unchanged" | "quarantined" | "error";

export interface RefIngestPayload {
  source_identifier: string;
  category: "ship_intel" | "port_intel" | "deck_intel" | string;
  text: string;
  source_url?: string;
  source_domain?: string;
  authority?: number;
  cruise_line?: string;
  ship?: string;
  destination?: string;
  // BP37 §33.6.2 — asset UUIDs the chunk references (deck plan images, etc.).
  related_asset_ids?: string[];
}

export interface RefIngestOutcome {
  status: RefIngestStatus;
  chunk_id?: string | null;
  reason?: string;
  httpStatus?: number;
}

export async function ingestReferenceToRag(payload: RefIngestPayload): Promise<RefIngestOutcome> {
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

  let res: Response;
  try {
    res = await fetch(`${ragUrl}/api/ingest/reference`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(payload),
      // Bound the call so a slow/hung RAG response can't stall the caller (#770).
      signal: AbortSignal.timeout(20_000),
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

  const status = (json.status as RefIngestStatus | undefined) ?? "error";
  const out: RefIngestOutcome = { status, httpStatus: res.status, chunk_id: typeof json.chunk_id === "string" ? json.chunk_id : null };
  if (typeof json.reason === "string") out.reason = json.reason;
  return out;
}
