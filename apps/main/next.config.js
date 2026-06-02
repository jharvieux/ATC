/** @type {import('next').NextConfig} */

// §572 — Content-Security-Policy in REPORT-ONLY (observation) mode.
//
// Deliberately a STATIC, NO-NONCE header so it adds zero rendering cost: nonce-based
// CSP would force every page into dynamic rendering (no static generation, no CDN
// caching → higher hosting cost), per the Next.js CSP guide. Report-Only never blocks
// — it only sends violations to /api/security/csp-report so the real allowlist can be
// built from live data before an ENFORCING mechanism is chosen (nonce vs build-time
// SRI hashes — that decision, and its cost, is deferred and user-gated).
//
// Inline script/style are permitted ('unsafe-inline') on purpose: hardening the
// framework's own inline scripts IS the deferred enforce decision. script-src is
// otherwise kept strict (no https:, no wildcard) so EXTERNAL script origins still
// surface in reports. Low-XSS-risk directives (img/font) are relaxed to cut noise;
// the XSS-relevant ones (script/connect/frame/object/base-uri/form-action) stay strict
// to produce a useful allowlist signal.
const CSP_REPORT_ENDPOINT = "/api/security/csp-report";
const cspReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  `report-uri ${CSP_REPORT_ENDPOINT}`,
  "report-to csp-endpoint",
].join("; ");

// Security response headers. The nonce-independent ones (#557) plus the report-only
// CSP (#572) — all safe to apply statically to every route. The ENFORCING CSP is NOT
// here: that needs the post-observation enforce-mechanism decision (see #572).
const securityHeaders = [
  // Also added by Vercel for custom domains in prod; set here so dev, preview, and
  // non-custom-domain surfaces are covered too (ignored by browsers over plain HTTP).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  // Reporting API endpoint group referenced by the report-to directive (modern
  // browsers); report-uri covers older ones.
  { key: "Reporting-Endpoints", value: `csp-endpoint="${CSP_REPORT_ENDPOINT}"` },
];

const nextConfig = {
  transpilePackages: ["@atc/shared-types"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
