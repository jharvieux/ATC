import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteEntry {
  method: HttpMethod;
  path: string;
  hasParam: boolean;
  paramName?: string;
  filePath: string;
}

function findRouteFiles(dir: string, base: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findRouteFiles(full, base));
    } else if (entry === "route.ts" || entry === "route.js") {
      files.push(full);
    }
  }
  return files;
}

function filePathToRoute(filePath: string, apiRoot: string): string {
  const rel = relative(apiRoot, filePath);
  // Remove filename (route.ts / route.js)
  const segments = rel.split("/").slice(0, -1);
  const route =
    "/" +
    segments
      .map((s) => {
        // [...rest] catch-all
        if (s.startsWith("[...") && s.endsWith("]")) {
          return "*";
        }
        // [param] dynamic segment
        if (s.startsWith("[") && s.endsWith("]")) {
          return s;
        }
        return s;
      })
      .join("/");
  return route.replace(/^\/\//, "/");
}

function extractMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((m) => {
    const pattern = new RegExp(
      `export\\s+(async\\s+)?function\\s+${m}\\b`,
      "m",
    );
    return pattern.test(source);
  });
}

function extractParam(routePath: string): {
  hasParam: boolean;
  paramName?: string;
} {
  const match = routePath.match(/\[([^\]]+)\]/);
  if (!match) return { hasParam: false };
  const raw = match[1];
  const paramName = raw.startsWith("...") ? raw.slice(3) : raw;
  return { hasParam: true, paramName };
}

export function enumerateRoutes(apiRoot: string): RouteEntry[] {
  const files = findRouteFiles(apiRoot, apiRoot);
  const routes: RouteEntry[] = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const methods = extractMethods(source);
    const path = filePathToRoute(file, apiRoot);
    const { hasParam, paramName } = extractParam(path);

    for (const method of methods) {
      routes.push({ method, path, hasParam, paramName, filePath: file });
    }
  }

  return routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

// When run directly, print JSON manifest
if (process.argv[1] === import.meta.filename) {
  const apiRoot = join(process.cwd(), "src", "app", "api");
  const routes = enumerateRoutes(apiRoot);
  console.log(JSON.stringify(routes, null, 2));
}
