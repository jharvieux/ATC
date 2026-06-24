// F-ssrf-01 (#1381) — SSRF guard for server-side outbound fetches whose URL is
// influenced by stored/admin input (e.g. the travel-news RSS feed refresh).
//
// Reuses isInternalHost from @atc/contracts (single source of truth, also backing
// the safeUrl schema validator) to classify both a URL hostname and a
// DNS-resolved IP. Layers:
//   validateOutboundUrlStatic   — scheme allowlist + host classification (no DNS)
//   validateOutboundUrlResolved — static + resolve and reject internal addresses
//   fetchGuarded                — redirect:'manual' + per-hop re-validation
//
// Residual (documented): DNS rebinding (the name resolves public at check time
// then to an internal IP at connect time) is not fully closed — that needs a
// pinned-IP custom dispatcher. The checks below close the practical paths
// (file:/internal-literal/redirect-to-internal/public-name→private-A-record).

import { isInternalHost } from "@atc/contracts";
import { lookup } from "node:dns/promises";

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
// internal (closes the "public name → private A record" case). Use at fetch
// time, when DNS is authoritative.
export async function validateOutboundUrlResolved(url: string): Promise<SsrfCheck> {
  const stat = validateOutboundUrlStatic(url);
  if (!stat.allowed) return stat;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    return { allowed: false, reason: "dns_lookup_failed" };
  }
  if (addrs.length === 0) return { allowed: false, reason: "no_dns_records" };
  for (const { address } of addrs) {
    if (isInternalHost(address)) return { allowed: false, reason: `resolves_to_internal:${address}` };
  }
  return { allowed: true };
}

// fetch() with redirect:'manual' and per-hop SSRF re-validation, so a benign
// public URL can't 30x-redirect into an internal address. Throws SsrfBlockedError
// when a hop is disallowed.
export async function fetchGuarded(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = await validateOutboundUrlResolved(current);
    if (!check.allowed) throw new SsrfBlockedError(check.reason ?? "blocked");
    const res = await fetch(current, {
      ...rest,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
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
