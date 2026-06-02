import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Filesystem enumerator for the (admin) page surface. Drives the unauthenticated
// admin probe (admin-pages-unauth.spec.ts, security issue #559) and is unit-
// locked by tests/security/enumerate-page-routes.test.ts. Lives here (not in
// scripts/) because Playwright's loader imports cleanly from within tests/e2e
// but not from scripts/ — same reason _helpers.ts lives here.

// Sentinel substituted for dynamic [param] / [...catch-all] segments when
// building a concrete probe URL. UUID-shaped so it satisfies routes whose param
// is a tenant_id (the admin tree's only dynamic page is [tenant_id]); a route
// that 404s on a malformed id would 404 anyway, which is the assertion we want.
const PARAM_SENTINEL = "00000000-0000-0000-0000-000000000000";

export interface PageRoute {
  urlPath: string;
  probePath: string;
  hasParam: boolean;
  filePath: string;
}

function findPageFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findPageFiles(full));
    } else if (entry === "page.tsx" || entry === "page.js") {
      files.push(full);
    }
  }
  return files;
}

// Route-group folders "(group)" don't add a URL segment, so drop them.
function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

function filePathToUrl(filePath: string, appDir: string): string {
  const rel = relative(appDir, filePath);
  const segments = rel
    .split("/")
    .slice(0, -1) // drop page.tsx / page.js
    .filter((s) => !isRouteGroup(s));
  return "/" + segments.join("/");
}

function toProbePath(urlPath: string): string {
  // [param] and [...catch-all] both start with "[" and end with "]".
  return urlPath
    .split("/")
    .map((s) => (s.startsWith("[") && s.endsWith("]") ? PARAM_SENTINEL : s))
    .join("/");
}

// Enumerate every page under `appDir/subtree`, returning URLs with the subtree's
// route group stripped (because the URL is computed relative to appDir). Pass
// subtree="(admin)" to get the admin page surface.
export function enumeratePageRoutes(
  appDir: string,
  subtree: string,
): PageRoute[] {
  const files = findPageFiles(join(appDir, subtree));
  const routes: PageRoute[] = files.map((filePath) => {
    const urlPath = filePathToUrl(filePath, appDir);
    return {
      urlPath,
      probePath: toProbePath(urlPath),
      hasParam: /\[[^\]]+\]/.test(urlPath),
      filePath,
    };
  });
  return routes.sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}
