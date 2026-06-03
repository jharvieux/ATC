// Dev-only UI screenshot helper. Renders a route from the running dev server
// to a PNG so UI work can be reviewed visually (and diffed before/after).
//
// Usage:
//   node scripts/ui-screenshot.mjs <route> [outFile] [viewport]
// Examples:
//   node scripts/ui-screenshot.mjs /signup
//   node scripts/ui-screenshot.mjs /signup /tmp/signup.png mobile
//
// Requires the dev server running on $PORT (default 3000). Chromium comes from
// the @playwright/test install already used by the e2e tests — no extra deps.

import { chromium } from "@playwright/test";

const route = process.argv[2] ?? "/";
const outFile = process.argv[3] ?? `/tmp/ui-${route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}.png`;
const viewportArg = process.argv[4] ?? "desktop";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};
const viewport = VIEWPORTS[viewportArg] ?? VIEWPORTS.desktop;

const port = process.env.PORT ?? "3000";
const url = `http://localhost:${port}${route}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport });
try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
} catch {
  // networkidle can hang on streaming/long-poll routes — fall back to load.
  await page.goto(url, { waitUntil: "load", timeout: 30000 });
}
await page.screenshot({ path: outFile, fullPage: true });
await browser.close();
console.log(`Captured ${url} (${viewportArg}) -> ${outFile}`);
