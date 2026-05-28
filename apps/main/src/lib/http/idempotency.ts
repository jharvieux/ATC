// §7.9 — Idempotency-Key HTTP header handler.
//
// Routes that opt in wrap their POST/PATCH/DELETE handler in
// withIdempotencyKey(). The wrapper:
//   1. If the request carries no Idempotency-Key header, just runs the
//      handler (no caching). The header is OPTIONAL — backward compatible.
//   2. If the header is present, checks the request_idempotency table:
//      a. Cache HIT (same key + route + auth_user_id, not expired) →
//         return the cached response status + body.
//      b. Cache MISS → run handler, store its response with 24h TTL,
//         return.
//   3. Auth-scoped: the cached response is only replayed for the SAME
//      auth_user_id. An attacker who guesses a key cannot replay another
//      user's response. Anonymous calls (no auth_user_id) are cached
//      per-key without the user check; the use case is server-to-server
//      retries from a known client.
//
// Concurrency: a real race (two requests with the same key arriving
// simultaneously) is possible. The PRIMARY KEY (idempotency_key, route)
// constraint means the second insert fails with code 23505; we treat
// that as "another request already cached" and replay the existing row.
// Result: at most one handler runs per (key, route).
//
// Storage: only the response body + status are cached. Side effects of
// the handler (DB writes, vendor calls) still happen during the first
// call; the second call returns the cached response without re-running
// the handler. This is the contract Stripe and others use — the client
// trusts that the first call's side effects completed if it got a 200.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
const MAX_KEY_LENGTH = 255;
// Keys are caller-supplied opaque strings. We only require they're
// printable ASCII and reasonable length — anything else is rejected
// rather than silently truncated.
const VALID_KEY_RE = /^[\x21-\x7E]{1,255}$/;

export interface IdempotencyOptions {
  // Stable route identifier. Use the spec section + handler name, e.g.
  // "bookings.submit" — short enough to fit in the index, stable across
  // refactors. Don't include `/api/` prefix because that's noise.
  route: string;
  // Optional: the auth user ID for the calling principal. When provided,
  // the cache is scoped to this user (prevents replay across users with
  // a guessed key). Defaults to null = anonymous-scoped.
  auth_user_id?: string | null;
  // Optional: the tenant ID. Stored for auditability; not used in the
  // cache lookup (the route + key + user combination is the dedup key).
  tenant_id?: string | null;
}

export interface IdempotencyHit {
  status: number;
  body: string;
  content_type: string | null;
  cached_at: string;
}

interface RawIdempotencyRow {
  response_status: number;
  response_body: string;
  response_content_type: string | null;
  created_at: string;
}

/**
 * Wrap a route handler with Idempotency-Key support. The handler runs
 * exactly once per (key, route, auth_user_id) within the 24h cache window;
 * subsequent calls return the cached response.
 *
 * Backward compatible: callers without the header bypass the cache entirely.
 *
 * Usage:
 *   export async function POST(req: Request) {
 *     const { ctx, user } = await assertPermission(req, { ... });
 *     return withIdempotencyKey(
 *       req,
 *       { route: "bookings.submit", auth_user_id: user.id, tenant_id: ctx.tenant_id },
 *       async () => {
 *         // ... the actual handler body ...
 *         return Response.json({ ok: true });
 *       },
 *     );
 *   }
 */
export async function withIdempotencyKey(
  req: Request,
  opts: IdempotencyOptions,
  handler: () => Promise<Response>,
): Promise<Response> {
  const key = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (!key) {
    // Header absent — no caching, just run.
    return handler();
  }

  if (!VALID_KEY_RE.test(key)) {
    return Response.json(
      { error: "invalid_idempotency_key", detail: `Key must be printable ASCII, 1-${MAX_KEY_LENGTH} chars.` },
      { status: 400 },
    );
  }

  const db = createServiceRoleClient();

  // Step 1: cache lookup. Scoped by route + key + user (anonymous keys
  // share a scope across callers — same use case as Stripe's anonymous
  // idempotency: server-to-server retries from a known client).
  const hit = await lookupCache(db, opts.route, key, opts.auth_user_id ?? null);
  if (hit) {
    return rebuildResponse(hit);
  }

  // Step 2: run the handler. The response is consumed (Response bodies
  // are streams that can only be read once) so we buffer it before
  // returning a fresh Response to the caller.
  const handlerRes = await handler();
  const buffered = await bufferResponse(handlerRes);

  // Step 3: write to the cache. ON CONFLICT here means a concurrent
  // request beat us to it — return THEIR cached response rather than
  // re-running. This is the standard Stripe-style race resolution.
  const { error: insertErr } = await db
    .from("request_idempotency")
    .insert({
      idempotency_key: key,
      route: opts.route,
      tenant_id: opts.tenant_id ?? null,
      auth_user_id: opts.auth_user_id ?? null,
      response_status: buffered.status,
      response_body: buffered.body,
      response_content_type: buffered.content_type,
    });

  if (insertErr && insertErr.code === "23505") {
    // Concurrent write — somebody else cached first. Return theirs.
    const concurrent = await lookupCache(db, opts.route, key, opts.auth_user_id ?? null);
    if (concurrent) return rebuildResponse(concurrent);
    // No row found despite the 23505 — schema drift? Fall back to the
    // handler response we just computed.
    return rebuildResponse(buffered);
  }
  if (insertErr) {
    // Don't fail the response on cache-insert error; just log and return
    // the live handler response. Next caller with the same key will
    // re-run the handler — at-least-once is the worst we get.
    console.warn(
      "[idempotency] cache insert failed key=%s route=%s code=%s",
      key.replace(/[\r\n]/g, " "),
      opts.route,
      insertErr.code,
    );
  }

  return rebuildResponse(buffered);
}

async function lookupCache(
  db: SupabaseClient,
  route: string,
  key: string,
  auth_user_id: string | null,
): Promise<IdempotencyHit | null> {
  let query = db
    .from("request_idempotency")
    .select("response_status, response_body, response_content_type, created_at")
    .eq("idempotency_key", key)
    .eq("route", route)
    .gt("expires_at", new Date().toISOString());

  // User-scoped lookup: an attacker who guesses a key under a different
  // identity must not get the original user's cached response. Anonymous
  // calls (auth_user_id=null) share a scope per-key.
  if (auth_user_id) {
    query = query.eq("auth_user_id", auth_user_id);
  } else {
    query = query.is("auth_user_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error || !data) return null;
  const row = data as RawIdempotencyRow;
  return {
    status: row.response_status,
    body: row.response_body,
    content_type: row.response_content_type,
    cached_at: row.created_at,
  };
}

async function bufferResponse(res: Response): Promise<IdempotencyHit> {
  const body = await res.text();
  return {
    status: res.status,
    body,
    content_type: res.headers.get("content-type"),
    cached_at: new Date().toISOString(),
  };
}

function rebuildResponse(hit: IdempotencyHit): Response {
  const headers = new Headers();
  if (hit.content_type) headers.set("Content-Type", hit.content_type);
  headers.set("X-Idempotent-Replay", hit.cached_at);
  return new Response(hit.body, { status: hit.status, headers });
}
