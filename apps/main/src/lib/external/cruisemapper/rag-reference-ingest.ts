// BP36 §33.5 — RAG-side client for reference content ingest.
//
// POSTs to /api/ingest/reference. Same SERVICE_JWT bearer pattern as the
// itinerary endpoint (TODO bp24-service-jwt — RS256 signature deferred).

export type RefIngestStatus = "ingested" | "updated" | "unchanged" | "quarantined" | "error";

export interface RefIngestPayload {
  source_identifier: string;
  category: "ship_intel" | "port_intel" | string;
  text: string;
  source_url?: string;
  source_domain?: string;
  authority?: number;
  cruise_line?: string;
  ship?: string;
  destination?: string;
}

export interface RefIngestOutcome {
  status: RefIngestStatus;
  chunk_id?: string | null;
  reason?: string;
  httpStatus?: number;
}

export async function ingestReferenceToRag(payload: RefIngestPayload): Promise<RefIngestOutcome> {
  const ragUrl = process.env.RAG_SERVICE_URL;
  const bearer = process.env.SERVICE_JWT_PRIVATE_KEY ?? "";
  if (!ragUrl) return { status: "error", reason: "RAG_SERVICE_URL not set" };

  let res: Response;
  try {
    res = await fetch(`${ragUrl}/api/ingest/reference`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
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

  const status = (json.status as RefIngestStatus | undefined) ?? "error";
  const out: RefIngestOutcome = { status, httpStatus: res.status, chunk_id: typeof json.chunk_id === "string" ? json.chunk_id : null };
  if (typeof json.reason === "string") out.reason = json.reason;
  return out;
}
