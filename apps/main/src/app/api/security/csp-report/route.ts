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
import { parseCspReports, signatureOf, createViolationDeduper } from "@/lib/security/csp-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCEPTED_CONTENT_TYPES = [
  "application/csp-report", // legacy report-uri
  "application/reports+json", // Reporting API (report-to)
  "application/json", // bare report posts
];
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_CHARS = 512;

// Log a given (effective-directive, blocked-origin) at most once per 10 minutes,
// bounded at 500 tracked signatures. Telemetry hygiene, not a security gate.
const deduper = createViolationDeduper({ windowMs: 10 * 60 * 1000, maxSignatures: 500 });

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
  // Byte length, not char length: a body of multi-byte glyphs is larger on the wire
  // than its string .length. runtime is nodejs, so Buffer is available.
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
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
    if (!deduper.shouldLog(signatureOf(v))) continue;
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

function cap(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS)}…` : s;
}
