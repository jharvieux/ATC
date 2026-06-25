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

const ALLOWED_SCHEMES = new Set(["https:", "http:"]);
const MAX_REDIRECTS = 5;

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`ssrf_blocked:${reason}`);
    this.name = "SsrfBlockedError";
  }
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
  init: { method?: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80);
    // Build opts with `lookup` typed permissively; both http/https accept it at runtime.
    const opts = {
      hostname: u.hostname,
      port,
      path: u.pathname + u.search,
      method: init.method ?? "GET",
      headers: { host: u.hostname, ...init.headers },
      lookup: (
        _h: string,
        _o: Record<string, unknown>,
        cb: (err: Error | null, address: string, family: number) => void,
      ) => cb(null, pinnedIp, pinnedFamily),
    } as import("node:http").RequestOptions;

    const req = u.protocol === "https:" ? httpsRequest(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") resHeaders.set(k, v);
          else if (Array.isArray(v)) v.forEach((h) => resHeaders.append(k, h));
        }
        resolve(new Response(Buffer.concat(chunks), { status, headers: resHeaders }));
      });
      res.on("error", reject);
    }) : httpRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const resHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") resHeaders.set(k, v);
            else if (Array.isArray(v)) v.forEach((h) => resHeaders.append(k, h));
          }
          resolve(new Response(Buffer.concat(chunks), { status, headers: resHeaders }));
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error("fetch_timeout")));
    req.on("error", reject);
    req.end();
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
  const { timeoutMs = 10_000, method, headers } = init;
  const flatHeaders = headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : (headers as Record<string, string> | undefined);

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateOutboundUrlResolved(current);
    if (!check.allowed) throw new SsrfBlockedError(check.reason ?? "blocked");
    const hopInit: Parameters<typeof fetchPinnedHop>[3] = { timeoutMs };
    if (method) hopInit.method = method as string;
    if (flatHeaders) hopInit.headers = flatHeaders;
    const res = await fetchPinnedHop(current, check.pinnedIp!, check.pinnedFamily!, hopInit);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlockedError("too_many_redirects");
}
