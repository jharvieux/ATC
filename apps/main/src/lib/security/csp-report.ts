// §572 — CSP violation report parsing.
//
// Browsers post CSP violations in two on-the-wire shapes, and we wire both
// (report-uri + report-to) so coverage doesn't depend on browser age:
//
//   - Legacy `report-uri` (Content-Type: application/csp-report): a single object
//     `{ "csp-report": { "document-uri", "violated-directive", "blocked-uri", ... } }`
//     with kebab-case keys. Some clients post the bare inner object as
//     application/json.
//   - Reporting API `report-to` (Content-Type: application/reports+json): an ARRAY of
//     `{ type, url, body: { documentURL, blockedURL, effectiveDirective, ... } }` with
//     camelCase keys; entries that aren't `type: "csp-violation"` (e.g. deprecation
//     reports) share the endpoint and must be filtered out.
//
// This module is pure (no I/O) so the dual-format normalization is unit-testable; the
// route handler is its only runtime caller.

export interface CspViolation {
  documentUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  blockedUri: string;
  disposition: string;
}

export function parseCspReports(body: unknown, contentType: string): CspViolation[] {
  if (contentType === "application/reports+json") {
    if (!Array.isArray(body)) return [];
    return body
      .filter(isRecord)
      .filter((r) => r["type"] === "csp-violation" && isRecord(r["body"]))
      .map((r) => normalizeReportingApi(r["body"] as Record<string, unknown>))
      .filter((v): v is CspViolation => v !== null);
  }

  // Legacy report-uri (application/csp-report) or a bare application/json post.
  if (!isRecord(body)) return [];
  const inner = isRecord(body["csp-report"]) ? body["csp-report"] : body;
  const v = normalizeLegacy(inner);
  return v ? [v] : [];
}

function normalizeLegacy(r: Record<string, unknown>): CspViolation | null {
  const violatedDirective = str(r["violated-directive"]);
  return finalize({
    documentUri: str(r["document-uri"]),
    violatedDirective,
    effectiveDirective: str(r["effective-directive"]) || firstToken(violatedDirective),
    blockedUri: str(r["blocked-uri"]),
    disposition: str(r["disposition"]) || "report",
  });
}

function normalizeReportingApi(r: Record<string, unknown>): CspViolation | null {
  const violatedDirective = str(r["violatedDirective"]);
  return finalize({
    documentUri: str(r["documentURL"]),
    violatedDirective,
    effectiveDirective: str(r["effectiveDirective"]) || firstToken(violatedDirective),
    blockedUri: str(r["blockedURL"]),
    disposition: str(r["disposition"]) || "report",
  });
}

// A report with no directive and no blocked-uri carries nothing worth recording —
// drop it so junk bodies normalize to an empty list rather than blank log lines.
function finalize(v: CspViolation): CspViolation | null {
  if (!v.violatedDirective && !v.effectiveDirective && !v.blockedUri) return null;
  return v;
}

function firstToken(directive: string): string {
  return directive.split(" ")[0] ?? "";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

// ── Log de-dup ───────────────────────────────────────────────────────────────
// A violation's log signature is (effective-directive, blocked-origin): two reports
// that differ only by path are the same finding for allowlist-building purposes, so we
// collapse them.

export function signatureOf(v: CspViolation): string {
  let origin = v.blockedUri;
  try {
    origin = new URL(v.blockedUri).origin;
  } catch {
    // blocked-uri is often a keyword ("inline", "eval", "data") rather than a URL.
  }
  return `${v.effectiveDirective || v.violatedDirective}|${origin}`;
}

export interface ViolationDeduper {
  shouldLog(signature: string): boolean;
}

// Logs a given signature at most once per window; bounded so a flood of UNIQUE
// signatures can't grow memory without limit (at the cap it clears and starts over).
// This is telemetry hygiene, NOT a security gate — clearing just re-logs a signature,
// which is harmless. Window/cap are injected so the behavior is unit-testable.
export function createViolationDeduper(opts: { windowMs: number; maxSignatures: number }): ViolationDeduper {
  const seen = new Map<string, number>();
  return {
    shouldLog(signature: string): boolean {
      const now = Date.now();
      const last = seen.get(signature);
      if (last !== undefined && now - last < opts.windowMs) return false;
      if (seen.size >= opts.maxSignatures) seen.clear();
      seen.set(signature, now);
      return true;
    },
  };
}
