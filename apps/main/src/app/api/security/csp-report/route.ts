// §572 — Content-Security-Policy violation collector (report-only observation phase).
//
// Browsers POST CSP violation reports here, wired via the report-uri + report-to
// directives set in next.config.js. UNAUTHENTICATED by design — browsers post these
// directly with no credentials. It makes NO allow/deny decision and writes NOTHING to
// the database; it is a telemetry sink that answers 204 on any well-formed report.
//
// Abuse resistance (the issue's explicit ask, since it's publicly reachable): accept
// only known report content-types (else 415), cap the body size (else 413), and
// de-dupe log output by (effective-directive, blocked-origin) so a flood of identical
// reports can't flood the logs. Conventional request-rate / DoS limiting is the
// platform edge's job (Vercel), not this handler's.
//
// Violations are logged as structured JSON (greppable by the "csp-violation" tag),
// not persisted: a DB table would need a prod migration + RLS + grants, and this is a
// temporary observation window. If durable, queryable storage is wanted later, that's
// a follow-up migration through the normal prod-apply process.

import { NextResponse } from "next/server";
import { parseCspReports } from "@/lib/security/csp-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPTED_CONTENT_TYPES = [
  "application/csp-report", // legacy report-uri
  "application/reports+json", // Reporting API (report-to)
  "application/json", // bare report posts
];
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 512;

// Log-dedup: a given (effective-directive, blocked-origin) signature is logged at most
// once per window. Bounded so a flood of UNIQUE signatures can't grow memory without
// limit. This is telemetry hygiene, NOT a security gate — clearing the map only means
// a signature gets logged again, which is harmless.
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_SIGNATURES = 500;
const loggedSignatures = new Map<string, number>();

export async function POST(req: Request): Promise<Response> {
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ACCEPTED_CONTENT_TYPES.includes(contentType)) {
    return new NextResponse(null, { status: 415 });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // Telemetry sink: a malformed body is swallowed (204), not surfaced as a client
  // error — the browser ignores the response either way.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  for (const v of parseCspReports(parsed, contentType)) {
    if (!shouldLog(signatureOf(v))) continue;
    // JSON.stringify (not concatenation) escapes attacker-controlled report fields, so
    // a crafted blocked-uri can't inject newlines and forge extra log lines.
    console.warn(
      JSON.stringify({
        tag: "csp-violation",
        documentUri: cap(v.documentUri),
        violatedDirective: cap(v.violatedDirective),
        effectiveDirective: cap(v.effectiveDirective),
        blockedUri: cap(v.blockedUri),
        disposition: cap(v.disposition),
      }),
    );
  }

  return new NextResponse(null, { status: 204 });
}

function signatureOf(v: { effectiveDirective: string; violatedDirective: string; blockedUri: string }): string {
  let origin = v.blockedUri;
  try {
    origin = new URL(v.blockedUri).origin;
  } catch {
    // blocked-uri is often a keyword ("inline", "eval", "data") rather than a URL.
  }
  return `${v.effectiveDirective || v.violatedDirective}|${origin}`;
}

function shouldLog(signature: string): boolean {
  const now = Date.now();
  const last = loggedSignatures.get(signature);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) return false;
  if (loggedSignatures.size >= MAX_TRACKED_SIGNATURES) loggedSignatures.clear();
  loggedSignatures.set(signature, now);
  return true;
}

function cap(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : s;
}
