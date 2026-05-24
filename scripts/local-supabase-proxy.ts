// Tier 2.5 — tiny path-rewriting reverse proxy.
//
// The Supabase JS client constructs URLs like `${SUPABASE_URL}/rest/v1/<table>`
// and `${SUPABASE_URL}/auth/v1/...`. PostgREST serves tables at `/<table>`
// directly. This proxy listens on :54321 and forwards `/rest/v1/...` to
// PostgREST at :54331 with the prefix stripped.
//
// `/auth/v1/...` requests (Supabase auth) get a 200 OK stub since the
// Tier-2 auth bypass means routes don't actually need GoTrue.
//
// Run with:  pnpm tsx scripts/local-supabase-proxy.ts
// Or auto-started by Playwright's webServer (see playwright.config.ts).

import http from "node:http";
import { request as httpRequest } from "node:http";

const LISTEN_PORT = 54321;
const POSTGREST_PORT = 54331; // postgrest moved off 54321 to avoid the collision
const POSTGREST_HOST = "127.0.0.1";

const REST_PREFIX = "/rest/v1";
const AUTH_PREFIX = "/auth/v1";

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url.startsWith(AUTH_PREFIX)) {
    // The Tier-2 bypass replaces real auth. Anything that calls GoTrue
    // here is a bug — return 401 so the failure is visible, not silent.
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "tier2_no_gotrue", path: url }));
    return;
  }

  if (url.startsWith(REST_PREFIX)) {
    const targetPath = url.slice(REST_PREFIX.length) || "/";
    const proxyReq = httpRequest(
      {
        host: POSTGREST_HOST,
        port: POSTGREST_PORT,
        method: req.method,
        path: targetPath,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      },
    );
    proxyReq.on("error", (err) => {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // Health check / unknown path.
  if (url === "/" || url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", service: "tier2-supabase-proxy" }));
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "not_found", path: url }));
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[tier2-proxy] listening on http://127.0.0.1:${LISTEN_PORT}, forwarding ${REST_PREFIX} → http://${POSTGREST_HOST}:${POSTGREST_PORT}`);
});
