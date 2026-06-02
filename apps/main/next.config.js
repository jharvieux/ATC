/** @type {import('next').NextConfig} */

// Security response headers (#557). These are the nonce-independent ones, safe to
// apply statically to every route. Content-Security-Policy is intentionally NOT
// here: a correct CSP for the App Router needs per-request nonces + a report-only
// observation window before enforcing — tracked in #572.
const securityHeaders = [
  // Also added by Vercel for custom domains in prod; set here so dev, preview, and
  // non-custom-domain surfaces are covered too (ignored by browsers over plain HTTP).
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig = {
  transpilePackages: ["@atc/shared-types"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

module.exports = nextConfig;
