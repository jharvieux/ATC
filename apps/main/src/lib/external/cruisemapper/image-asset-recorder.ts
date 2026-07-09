// BP37 §33.6.3 — image asset recorder.
//
// Hot-linked only — no image fetch, no Supabase Storage upload. Records
// rag_media_assets rows in the RAG service via a dedicated endpoint
// (/api/admin/media-assets/upsert). Idempotency by (entity_id, image_url).
//
// Host allowlist is enforced HERE before any network call. URLs not on
// the allowlist (including private/loopback/link-local IPs) are logged
// and skipped — never recorded, never surfaced to the customer.
//
// Auth (BP09): RS256 JWT, PLATFORM sentinel tenant — deck-plan images are
// global reference content shared across tenants.

import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";

const HOST_ALLOWLIST = new Set<string>([
  "cruisemapper.com",
  "www.cruisemapper.com",
  // CruiseMapper CDN hosts (observed in field; extend via env var when needed).
  "cdn.cruisemapper.com",
]);

// CruiseMapper publishes deck plan images as .gif (/images/deckplans/<hex>.gif),
// so gif must be allowed alongside the photographic formats.
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif)(\?.*)?$/i;

export interface RecordImageInput {
  imageUrl: string;
  sourcePageUrl: string;
  shipSlug: string;
  deckNumber: number | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface RecordImageOutcome {
  status: "recorded" | "skipped" | "error";
  asset_id?: string;
  reason?: string;
}

function isHostAllowed(url: string): { allowed: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { allowed: false, reason: "invalid_url" }; }

  // Reject schemes other than https/http.
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { allowed: false, reason: `bad_scheme:${u.protocol}` };
  }

  const host = u.hostname.toLowerCase();
  if (!HOST_ALLOWLIST.has(host)) {
    return { allowed: false, reason: `host_not_allowlisted:${host}` };
  }

  // Reject IP-literal hosts entirely (private/loopback/link-local guard).
  // The allowlist above already restricts to known FQDNs, but belt + braces.
  if (/^[\d.]+$/.test(host) || host.includes(":")) {
    return { allowed: false, reason: "ip_literal_host" };
  }

  if (!IMAGE_EXT_RE.test(u.pathname)) {
    return { allowed: false, reason: "missing_image_extension" };
  }

  return { allowed: true };
}

// Shared by recordDeckPlanImage / recordCabinImage (#1610) — both upsert
// via the same RAG endpoint, differing only in the payload they build.
async function upsertMediaAsset(payload: Record<string, unknown>): Promise<RecordImageOutcome> {
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
    res = await fetch(`${ragUrl}/api/admin/media-assets/upsert`, {
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
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* tolerate */ }

  if (!res.ok) {
    return { status: "error", reason: typeof json.error === "string" ? json.error : `HTTP ${res.status}` };
  }
  const assetId = typeof json.asset_id === "string" ? json.asset_id : undefined;
  return assetId ? { status: "recorded", asset_id: assetId } : { status: "error", reason: "no_asset_id_returned" };
}

/**
 * Record a hot-linked deck plan image. Calls the RAG service to upsert
 * a rag_media_assets row.
 */
export async function recordDeckPlanImage(input: RecordImageInput): Promise<RecordImageOutcome> {
  const validation = isHostAllowed(input.imageUrl);
  if (!validation.allowed) {
    console.warn(`[cm-diy] image rejected: ${input.imageUrl} (${validation.reason})`);
    const out: RecordImageOutcome = { status: "skipped" };
    if (validation.reason) out.reason = validation.reason;
    return out;
  }

  const entityId = `${input.shipSlug}-deck-${String(input.deckNumber ?? "?").padStart(2, "0")}`;

  return upsertMediaAsset({
    kind: "deck_plan",
    entity_type: "deck",
    entity_id: entityId,
    scope: "global",
    image_url: input.imageUrl,
    source_page_url: input.sourcePageUrl,
    attribution: "Image: CruiseMapper",
    caption: input.caption ?? null,
    width_px: input.width ?? null,
    height_px: input.height ?? null,
    source: "cruisemapper.com",
  });
}

export interface RecordCabinImageInput {
  imageUrl: string;
  sourcePageUrl: string;
  shipSlug: string;
  categoryName: string;
  imageType: "floor_plan" | "photo";
  caption?: string | null;
}

// §953 Phase A — record a hot-linked cabin floor plan or photo.
export async function recordCabinImage(input: RecordCabinImageInput): Promise<RecordImageOutcome> {
  const validation = isHostAllowed(input.imageUrl);
  if (!validation.allowed) {
    console.warn(`[cm-diy] cabin image rejected: ${input.imageUrl} (${validation.reason})`);
    const out: RecordImageOutcome = { status: "skipped" };
    if (validation.reason) out.reason = validation.reason;
    return out;
  }

  // entity_id = <shipSlug>-cabin-<category-slug> so floor plan + photos for the
  // same category share an entity; the image_url column provides the per-image key.
  const categorySlug = input.categoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const entityId = `${input.shipSlug}-cabin-${categorySlug}`;

  return upsertMediaAsset({
    kind: input.imageType === "floor_plan" ? "cabin_plan" : "cabin_photo",
    entity_type: "cabin",
    entity_id: entityId,
    scope: "global",
    image_url: input.imageUrl,
    source_page_url: input.sourcePageUrl,
    attribution: "Image: CruiseMapper",
    caption: input.caption ?? null,
    width_px: null,
    height_px: null,
    source: "cruisemapper.com",
  });
}

// Test-only export.
export const _isHostAllowedForTests = isHostAllowed;
