// BP36 §33.5 — disciplined HTTP fetcher for CruiseMapper DIY ingest.
//
// Discipline (in order):
//   1. Kill switch (CRUISEMAPPER_DIY_INGEST_ENABLED) — caller is the
//      Inngest job; the fetcher itself doesn't check the kill switch on
//      every call (callers do once per run). What it DOES enforce here:
//   2. robots.txt — checkRobotsAllowed(url) before sending any request.
//      Disallowed URLs return { status: 'robots_disallowed' } and alert.
//   3. Rate limit — token bucket acquire() before send.
//   4. User-Agent header — required (no anonymous scrapes).
//   5. Backoff — exponential with jitter on 429/5xx/network errors; 3
//      retries then give up. 4xx (non-429) is terminal, no retry.
//
// Change detection: the hash is computed by the *caller* over the parser
// output (text + image-url list) — not the raw body. The fetcher just
// returns the body; if the caller's computed hash matches `previousHash`,
// the caller skips re-ingest. The fetcher exposes a convenience wrapper
// `fetchAndExtractHashFromBody` for callers that want the simpler
// raw-body-hash path (used by URL discovery where there's no parsed
// content yet).

import { createHash } from "node:crypto";
import { checkRobotsAllowed } from "./robots-check";
import { getCruiseMapperRateLimiter } from "./rate-limiter";

export type FetchResult =
  | { status: "ok"; body: string; bodyHash: string; latencyMs: number; url: string }
  | { status: "unchanged"; bodyHash: string; latencyMs: number; url: string }
  | { status: "robots_disallowed"; url: string }
  | { status: "client_error"; code: number; url: string }
  | { status: "server_error"; code: number; url: string }
  | { status: "network_error"; message: string; url: string }
  | { status: "config_missing"; reason: "no_user_agent"; url: string };

export interface FetchOptions {
  /** If set, when bodyHash matches we return {status:'unchanged'}. */
  previousBodyHash?: string;
  /** Total request timeout in ms. Default 20s. */
  timeoutMs?: number;
  /** Extra request headers, merged over the defaults (can override Accept).
   *  #827: /ships/cruise.json needs X-Requested-With: XMLHttpRequest, else it
   *  returns 200 with an empty body. */
  headers?: Record<string, string>;
}

const MAX_RETRIES = 3;

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s + ±25% jitter.
  const base = Math.pow(2, attempt) * 1000;
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(250, Math.round(base + jitter));
}

async function sleep(ms: number): Promise<void> { await new Promise((r) => setTimeout(r, ms)); }

export async function fetchCruiseMapperPage(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const ua = process.env.CRUISEMAPPER_DIY_USER_AGENT;
  if (!ua) return { status: "config_missing", reason: "no_user_agent", url };

  const allowed = await checkRobotsAllowed(url);
  if (!allowed) {
    // robots-check emits its own alert on fetch failure; for an explicit
    // Disallow we still want a log line so operators see the count.
    console.warn(`[cm-diy] robots_disallowed: ${url}`);
    return { status: "robots_disallowed", url };
  }

  await getCruiseMapperRateLimiter().acquire();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": ua, Accept: "text/html", ...options.headers },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - start;

      if (res.ok) {
        const body = await res.text();
        const bodyHash = createHash("sha256").update(body).digest("hex");
        if (options.previousBodyHash && bodyHash === options.previousBodyHash) {
          console.log(`[cm-diy] ${url} ${res.status} ${latencyMs}ms unchanged`);
          return { status: "unchanged", bodyHash, latencyMs, url };
        }
        console.log(`[cm-diy] ${url} ${res.status} ${latencyMs}ms hash=${bodyHash.slice(0, 12)}`);
        return { status: "ok", body, bodyHash, latencyMs, url };
      }

      // Non-OK paths.
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        console.warn(`[cm-diy] ${url} ${res.status} ${latencyMs}ms (gave up after ${MAX_RETRIES} attempts)`);
        return { status: "server_error", code: res.status, url };
      }
      console.warn(`[cm-diy] ${url} ${res.status} ${latencyMs}ms (client_error, no retry)`);
      return { status: "client_error", code: res.status, url };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      console.warn(`[cm-diy] ${url} network_error ${latencyMs}ms: ${message}`);
      return { status: "network_error", message, url };
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable — loop returns on every branch — but TS needs an exit.
  return { status: "network_error", message: "exhausted_retries", url };
}
