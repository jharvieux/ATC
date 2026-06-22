/** @type {import('next').NextConfig} */

// §572 — Content-Security-Policy: ENFORCING for the safe directives, with inline
// script/style still permitted (nonce-vs-hash inline hardening is the deferred,
// user-gated decision). Static, no-nonce header so it adds zero rendering cost — a
// nonce CSP forces every page into dynamic rendering (no static generation, no CDN
// caching → higher hosting cost), per the Next.js CSP guide.
//
// Enforced where it matters for XSS: object-src 'none', base-uri 'self',
// frame-ancestors 'none', form-action 'self', default-src 'self', and a connect-src
// locked to 'self' + the app's real backends. script-src/style-src keep
// 'unsafe-inline' (and script-src keeps 'unsafe-eval') on purpose — blocking the
// framework's own inline scripts is the deferred enforce step, not this one.
const CSP_REPORT_ENDPOINT = "/api/security/csp-report";

// connect-src can't be a static literal: the browser talks to Supabase (REST over
// https + realtime over wss) and Sentry (error ingest). Derive both from the same
// NEXT_PUBLIC_* vars the runtime uses so the allowlist can't drift from the actual
// endpoints. A missing/malformed var just omits that source (fail-closed: enforce
// would block it rather than silently widen the policy).
function buildConnectSrc() {
  const sources = ["'self'"];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const { host } = new URL(supabaseUrl);
      sources.push(`https://${host}`, `wss://${host}`);
    } catch {
      /* malformed URL — omit */
    }
  }
  const sentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (sentryDsn) {
    try {
      sources.push(new URL(sentryDsn).origin);
    } catch {
      /* malformed DSN — omit */
    }
  }
  return sources.join(" ");
}

// form-action allowlist. OAuth signup posts to /api/auth/oauth-initiate which
// 302s through https://<project>.supabase.co/auth/v1/authorize then on to the
// OAuth provider (Microsoft, Google, Facebook). Browsers apply form-action to
// the full redirect chain (CSP3 / Chrome), so every hop must be allowed or the
// navigation is silently blocked — observable only via report-uri (which is how
// this bug was found). Same fail-closed pattern as buildConnectSrc: a missing
// var omits the source rather than silently widening to '*'.
//
// Provider endpoints are hardcoded — they're the canonical stable IdP hosts and
// match ALLOWED_PROVIDERS in apps/main/src/app/api/auth/oauth-initiate/route.ts.
// Keeping them in sync is easier than wiring them through env vars.
const OAUTH_PROVIDER_FORM_ACTION_HOSTS = [
  "https://login.microsoftonline.com", // Azure / Microsoft
  "https://accounts.google.com",
  "https://www.facebook.com",
];

function buildFormActionSrc() {
  const sources = ["'self'"];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseUrl) {
    try {
      const { host } = new URL(supabaseUrl);
      sources.push(`https://${host}`);
    } catch {
      /* malformed URL — omit */
    }
  }
  sources.push(...OAUTH_PROVIDER_FORM_ACTION_HOSTS);
  return sources.join(" ");
}

const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `form-action ${buildFormActionSrc()}`,
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // https: wildcard kept (now enforcing): images are non-executable, so allowing
  // any https host carries no XSS risk — avoids breaking remote avatars/og images.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${buildConnectSrc()}`,
  "frame-src 'self'",
  `report-uri ${CSP_REPORT_ENDPOINT}`,
  "report-to csp-endpoint",
].join("; ");

// Enforce in production; stay report-only under `next dev` so HMR's ws: connection
// isn't blocked. Vercel preview builds run with NODE_ENV=production, so they enforce
// too — which is what makes a preview deploy a real pre-prod smoke test.
const cspHeaderKey =
  process.env.NODE_ENV === "production" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";

// Security response headers. Nonce-independent ones (#557) plus the CSP (#572) — all
// safe to apply statically to every route.
const securityHeaders = [
  // Also added by Vercel for custom domains in prod; set here so dev, preview, and
  // non-custom-domain surfaces are covered too (ignored by browsers over plain HTTP).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: cspHeaderKey, value: csp },
  // Reporting API endpoint group referenced by the report-to directive (modern
  // browsers); report-uri covers older ones.
  { key: "Reporting-Endpoints", value: `csp-endpoint="${CSP_REPORT_ENDPOINT}"` },
];

const nextConfig = {
  transpilePackages: ["@atc/shared-types"],
  // pdf-parse wraps pdfjs-dist, which loads its worker/standard-font assets at
  // runtime and breaks when webpack-bundled into a serverless function (it works
  // under plain `node` locally, then throws on Vercel). Mark it external so Next
  // loads it from node_modules in the function instead of bundling it. Without
  // this, every document-import PDF silently failed to extract text and the row
  // landed in parse_failed (BP34 §34.3 import pipeline + the rag-ingest PDF path).
  serverExternalPackages: ["pdf-parse"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
