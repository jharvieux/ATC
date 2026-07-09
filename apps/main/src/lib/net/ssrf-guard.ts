// F-ssrf-01 (#1381) — SSRF guard for server-side outbound fetches whose URL is
// influenced by stored/admin input (e.g. the travel-news RSS feed refresh).
//
// Reuses isInternalHost from @atc/contracts (single source of truth, also backing
// the safeUrl schema validator) to classify both a URL hostname and a
// DNS-resolved IP. Layers:
//   validateOutboundUrlStatic   — scheme allowlist + host classification (no DNS)
//   validateOutboundUrlResolved — static + resolve and reject internal addresses
//   fetchGuarded                — redirect:'manual' + per-hop re-validation with
//                                 pinned-IP connection to close the DNS-rebinding
//                                 TOCTOU window (#1402 / F-ssrf-dns-rebind).
//
// DNS-rebinding fix: after resolving the host address in validateOutboundUrlResolved,
// the validated IP is pinned into the connection via a custom http/https Agent
// whose lookup callback returns only the pre-validated address instead of re-resolving.
// This means even if a DNS record flips public→private between check and connect,
// the connect always goes to the address the guard approved.

import { isInternalHost } from "@atc/contracts";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);
const MAX_REDIRECTS = 5;

// #1597 — matches the 10MB cap used elsewhere for externally-supplied
// payloads (apps/main/src/app/api/imports/upload/route.ts's MAX_BYTES).
// Enforced both against the raw wire bytes (defends an unbounded/streamed
// body) and against the decompressed size (defends a small gzip/br payload
// that decompresses into something much larger).
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`ssrf_blocked:${reason}`);
    this.name = "SsrfBlockedError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(bytes: number) {
    super(`response_too_large:${bytes}`);
    this.name = "ResponseTooLargeError";
  }
}

// #1597 — fetchGuarded's RequestInit accepted `body` but silently dropped it
// (only method/headers/timeoutMs were forwarded). Fail loud instead: encode
// the common server-to-server body shapes, and throw for anything else
// (Blob/FormData/ReadableStream) rather than pretend to send it.
function encodeBody(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error(`fetchGuarded: unsupported body type (${Object.prototype.toString.call(body)})`);
}

function decompressBody(buf: Buffer, contentEncoding: string): Buffer {
  // maxOutputLength caps the DECOMPRESSED size so a small "gzip-of-zeros" bomb
  // can't materialize multi-GB before the post-decompress length check. zlib
  // throws RangeError(ERR_BUFFER_TOO_LARGE) the moment output would exceed the
  // cap instead of allocating the whole buffer first; fetchPinnedHop maps that
  // code to ResponseTooLargeError.
  const opts = { maxOutputLength: MAX_RESPONSE_BYTES };
  switch (contentEncoding.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(buf, opts);
    case "deflate":
      return inflateSync(buf, opts);
    case "br":
      return brotliDecompressSync(buf, opts);
    case "identity":
      return buf;
    default:
      throw new Error(`fetchGuarded: unsupported content-encoding "${contentEncoding}"`);
  }
}

function stripHeaders(
  headers: Record<string, string> | undefined,
  names: string[],
): Record<string, string> | undefined {
  if (!headers) return headers;
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())),
  );
}

export interface SsrfCheck {
  allowed: boolean;
  reason?: string;
  /** First resolved address, present when allowed=true. Used by fetchGuarded to pin the connection. */
  pinnedIp?: string;
  pinnedFamily?: number;
}

// Synchronous: scheme allowlist + host classification. No network. Safe to call
// at ingest time when an admin stores a URL.
export function validateOutboundUrlStatic(url: string): SsrfCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return { allowed: false, reason: `bad_scheme:${u.protocol}` };
  if (!u.hostname) return { allowed: false, reason: "empty_host" };
  if (isInternalHost(u.hostname)) return { allowed: false, reason: "internal_host" };
  return { allowed: true };
}

// Static checks PLUS DNS resolution — rejects if ANY resolved address is
// internal (closes the "public name → private A record" case). Returns the
// first resolved address so fetchGuarded can pin the connection (#1402).
export async function validateOutboundUrlResolved(url: string): Promise<SsrfCheck> {
  const stat = validateOutboundUrlStatic(url);
  if (!stat.allowed) return stat;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { allowed: false, reason: "dns_lookup_failed" };
  }
  if (addrs.length === 0) return { allowed: false, reason: "no_dns_records" };
  for (const { address } of addrs) {
    if (isInternalHost(address)) return { allowed: false, reason: `resolves_to_internal:${address}` };
  }
  // addrs.length > 0 guaranteed above; non-null assertion is safe.
  const first = addrs[0]!;
  return { allowed: true, pinnedIp: first.address, pinnedFamily: first.family };
}

// Single-hop HTTP/HTTPS request that connects to `pinnedIp` (bypassing DNS at
// connect time) while keeping the original hostname in the TLS SNI / Host header.
// Buffers the response body — fine for the RSS/API payloads we fetch.
function fetchPinnedHop(
  url: string,
  pinnedIp: string,
  pinnedFamily: number,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer; timeoutMs: number },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
    const headers: Record<string, string> = { host: u.hostname, ...init.headers };
    if (init.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      headers["content-length"] = String(init.body.length);
    }
    // Build opts with `lookup` typed permissively; both http/https accept it at runtime.
    const opts = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: init.method ?? "GET",
      headers,
      lookup: (
        _h: string,
        _o: Record<string, unknown>,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => cb(null, pinnedIp, pinnedFamily),
    } as import("node:http").RequestOptions;

    function onResponse(res: import("node:http").IncomingMessage): void {
      const declaredLength = Number(res.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        res.destroy();
        reject(new ResponseTooLargeError(declaredLength));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      res.on("data", (c: Buffer) => {
        if (settled) return;
        received += c.length;
        if (received > MAX_RESPONSE_BYTES) {
          settled = true;
          res.destroy();
          reject(new ResponseTooLargeError(received));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const status = res.statusCode ?? 0;
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") resHeaders.set(k, v);
          else if (Array.isArray(v)) v.forEach((h) => resHeaders.append(k, h));
        }

        let body: Buffer = Buffer.concat(chunks);
        const contentEncoding = resHeaders.get("content-encoding");
        if (contentEncoding) {
          try {
            body = decompressBody(body, contentEncoding);
          } catch (err) {
            // A gzip/br bomb trips zlib's maxOutputLength guard before the
            // buffer is fully allocated — classify it as too-large, not a
            // generic decode failure.
            if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
              reject(new ResponseTooLargeError(MAX_RESPONSE_BYTES));
              return;
            }
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          if (body.length > MAX_RESPONSE_BYTES) {
            reject(new ResponseTooLargeError(body.length));
            return;
          }
          // Body is already decoded; forwarding the original encoding/length
          // headers would make a caller try to decode it a second time.
          resHeaders.delete("content-encoding");
          resHeaders.delete("content-length");
        }
        resolve(new Response(new Uint8Array(body), { status, headers: resHeaders }));
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    }

    const reqFn = (u.protocol === "https:" ? httpsRequest : httpRequest) as typeof httpRequest;
    const req = reqFn(opts, onResponse);
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error("fetch_timeout")));
    req.on("error", reject);
    req.end(init.body);
  });
}

// fetchGuarded: per-hop SSRF validation + DNS-pinned connection.
// For each hop: resolve the URL, reject if any resolved address is internal,
// then connect directly to the first validated IP (lookup override) so a DNS
// rebind between check and connect cannot redirect to an internal host.
export async function fetchGuarded(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, method, headers, body } = init;
  const flatHeaders = headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : (headers as Record<string, string> | undefined);

  // These evolve across hops per standard fetch redirect security semantics.
  let current = url;
  let currentMethod = method as string | undefined;
  let currentHeaders = flatHeaders ? { ...flatHeaders } : undefined;
  let currentBody = encodeBody(body);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateOutboundUrlResolved(current);
    if (!check.allowed) throw new SsrfBlockedError(check.reason ?? "blocked");
    const hopInit: Parameters<typeof fetchPinnedHop>[3] = { timeoutMs };
    if (currentMethod) hopInit.method = currentMethod;
    if (currentHeaders) hopInit.headers = currentHeaders;
    if (currentBody) hopInit.body = currentBody;
    const res = await fetchPinnedHop(current, check.pinnedIp!, check.pinnedFamily!, hopInit);
    if (res.status < 300 || res.status >= 400) return res;

    const loc = res.headers.get("location");
    if (!loc) return res;
    const next = new URL(loc, current);
    const crossOrigin = next.origin !== new URL(current).origin;

    // Conservative-by-design redirect handling (deliberately stricter than the
    // WHATWG fetch spec, not a reimplementation of it — real fetch preserves
    // the body on a 307/308 even cross-origin; this guard drops it on ANY
    // cross-origin hop regardless of status):
    //  - 301/302/303 downgrade the method to GET and drop the request body
    //    (any origin) — a POST that lands on a GET target must not resend its body.
    //  - a cross-origin hop drops the body and strips credential-bearing headers
    //    (#1720: authorization, cookie, proxy-authorization) so a request
    //    payload / credential never leaks to a host the caller never authenticated to.
    //  - only a same-origin 307/308 preserves the original method + body.
    const downgrade = res.status === 301 || res.status === 302 || res.status === 303;
    if (downgrade) currentMethod = "GET";
    if (downgrade || crossOrigin) {
      currentBody = undefined;
      // A stale content-length/content-type without a body would hang the peer
      // (or misdescribe the request); drop them alongside the body.
      currentHeaders = stripHeaders(currentHeaders, ["content-length", "content-type"]);
    }
    if (crossOrigin) {
      currentHeaders = stripHeaders(currentHeaders, ["authorization", "cookie", "proxy-authorization"]);
    }
    current = next.toString();
  }
  throw new SsrfBlockedError("too_many_redirects");
}
