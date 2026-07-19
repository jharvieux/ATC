// App Router boundary guard — Harvey Tier-1 port (M9 finding classes).
//
// Ported from Harvey src/detectors/app-router.ts + src/detectors/common.ts
// @ 5b5aada, adapted for ATC (no Finding[] plumbing — repo check-script
// output/exit-code conventions). TypeScript compiler API — typescript is
// already a root devDependency; zero new deps.
//
// Two AST checks over apps/main/src (the App Router app):
//
//   server-client-leak — a server file passes a RAW DB query result variable
//     whole into an imported 'use client' component (spread or direct prop).
//     Every field on the row is serialized into the RSC payload — fields the
//     client never renders (other-tenant data, hashes, internal flags) still
//     ship to the browser. AST-tier complement to the regex-tier
//     check-client-data-leak.ts (which only sees the spread shape and can't
//     tell a raw row from a projected DTO).
//
//   missing-server-only — a module with no leading directive that reads a
//     secret env var, has no `import "server-only"` poison-pill, AND is
//     actually reachable from a 'use client' file through the import graph
//     (relative + tsconfig-alias imports). Reachability is what separates this
//     from the presence-only check-server-only.ts: only a real client import
//     path makes the missing guard an actual bundling risk.
//
// Server Action checks from the Harvey source are deliberately NOT ported —
// ATC has zero 'use server' actions (all mutations are route handlers), so
// there is nothing for them to scan.
//
// FREEZE-EXISTING / BLOCK-NEW: pre-existing hits frozen in
// scripts/app-router-boundaries-baseline.txt (count-keyed by <kind>::<file>).
// Currently empty — zero-tolerance for new findings. Fails loud when zero
// source files are found.
//
// Usage: tsx scripts/check-app-router-boundaries.ts [srcDir]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/app-router-boundaries-baseline.txt");

const SECRET_ENV_PATTERN = /process\.env\.(?!NEXT_PUBLIC_)[A-Z0-9_]*(SERVICE_ROLE|SECRET|PRIVATE_KEY|API_KEY|TOKEN)[A-Z0-9_]*/;
const SERVER_ONLY_EXEMPT_PATTERN = /(^|\/)(route\.tsx?|middleware\.ts)$/;

function parse(p: string, text: string): ts.SourceFile {
  return ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, /\.(tsx|jsx)$/.test(p) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function leadingDirective(sf: ts.SourceFile): "use client" | "use server" | undefined {
  const first = sf.statements[0];
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)) {
    if (first.expression.text === "use client") return "use client";
    if (first.expression.text === "use server") return "use server";
  }
  return undefined;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

// --- import resolution (relative + `@/` alias → apps/main/src) ---------------

function normalizeRepoPath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function candidatePaths(base: string): string[] {
  return [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`];
}

// ATC's apps/main/tsconfig maps `@/*` → `src/*`; srcPrefix is the repo-relative
// src root ("apps/main/src") so aliased specifiers resolve inside the scanned set.
function resolveImport(fromPath: string, specifier: string, allPaths: ReadonlySet<string>, srcPrefix: string): string | undefined {
  let base: string;
  if (specifier.startsWith(".")) base = normalizeRepoPath(`${path.posix.dirname(fromPath)}/${specifier}`);
  else if (specifier.startsWith("@/") || specifier.startsWith("~/")) base = normalizeRepoPath(`${srcPrefix}/${specifier.slice(2)}`);
  else return undefined;
  return candidatePaths(base).find((c) => allPaths.has(c));
}

// --- server→client leak ------------------------------------------------------

function callChainNames(node: ts.Expression): string[] {
  const names: string[] = [];
  let cur: ts.Expression = node;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    names.push(cur.expression.name.text);
    cur = cur.expression.expression;
  }
  return names;
}

function isDbQueryChain(node: ts.Expression): boolean {
  const names = callChainNames(node);
  return names.includes("from") && names.includes("select");
}

// Variables bound to a raw DB query result (`const rows = await db.from(…).select(…)`
// or `const { data: rows } = await …`).
function collectRawRowNames(sf: ts.SourceFile): Set<string> {
  const rawRowNames = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (ts.isCallExpression(init) && isDbQueryChain(init)) {
        if (ts.isIdentifier(node.name)) rawRowNames.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined;
            if (propName === "data" && ts.isIdentifier(el.name)) rawRowNames.add(el.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return rawRowNames;
}

function collectClientComponentImports(
  sf: ts.SourceFile,
  p: string,
  clientPaths: ReadonlySet<string>,
  allPaths: ReadonlySet<string>,
  srcPrefix: string,
): Map<string, string> {
  const imports = new Map<string, string>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
    const resolved = resolveImport(p, stmt.moduleSpecifier.text, allPaths, srcPrefix);
    if (!resolved || !clientPaths.has(resolved)) continue;
    const clause = stmt.importClause;
    if (clause.name) imports.set(clause.name.text, resolved);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) imports.set(el.name.text, resolved);
    }
  }
  return imports;
}

export interface BoundaryFinding {
  kind: "server-client-leak" | "missing-server-only";
  key: string; // <kind>::<file> — line-independent baseline identity
  file: string;
  line: number;
  detail: string;
}

function detectServerClientLeak(sources: ReadonlyMap<string, ts.SourceFile>, srcPrefix: string): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const allPaths = new Set(sources.keys());
  const clientPaths = new Set([...sources].filter(([, sf]) => leadingDirective(sf) === "use client").map(([p]) => p));

  for (const [p, sf] of sources) {
    if (leadingDirective(sf) === "use client") continue;
    const clientImports = collectClientComponentImports(sf, p, clientPaths, allPaths, srcPrefix);
    if (clientImports.size === 0) continue;
    const rawRowNames = collectRawRowNames(sf);
    if (rawRowNames.size === 0) continue;

    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tagName = node.tagName.getText(sf);
        if (clientImports.has(tagName)) {
          for (const attr of node.attributes.properties) {
            let exprText: string | undefined;
            if (ts.isJsxSpreadAttribute(attr) && ts.isIdentifier(attr.expression) && rawRowNames.has(attr.expression.text)) {
              exprText = `{...${attr.expression.text}}`;
            } else if (
              ts.isJsxAttribute(attr) &&
              attr.initializer &&
              ts.isJsxExpression(attr.initializer) &&
              attr.initializer.expression &&
              ts.isIdentifier(attr.initializer.expression) &&
              rawRowNames.has(attr.initializer.expression.text)
            ) {
              exprText = `${attr.name.getText(sf)}={${attr.initializer.expression.text}}`;
            }
            if (exprText) {
              findings.push({
                kind: "server-client-leak",
                key: `server-client-leak::${p}`,
                file: p,
                line: lineOf(sf, attr),
                detail: `raw DB row passed whole to client component <${tagName}> (${exprText}) — project to a minimal DTO first`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

// --- missing server-only -----------------------------------------------------

function hasServerOnlyImport(sf: ts.SourceFile): boolean {
  return sf.statements.some((s) => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "server-only");
}

function findSecretEnvAccess(sf: ts.SourceFile): ts.Node | undefined {
  let hit: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(node) && SECRET_ENV_PATTERN.test(node.getText(sf))) {
      hit = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hit;
}

function buildImportGraph(sources: ReadonlyMap<string, ts.SourceFile>, srcPrefix: string): Map<string, string[]> {
  const allPaths = new Set(sources.keys());
  const graph = new Map<string, string[]>();
  for (const [p, sf] of sources) {
    const edges: string[] = [];
    for (const stmt of sf.statements) {
      // Re-exports (`export * from "./x"`) pull the target into the bundle the
      // same as imports — both are reachability edges.
      const isEdge = (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier !== undefined && ts.isStringLiteral(stmt.moduleSpecifier);
      if (!isEdge) continue;
      const resolved = resolveImport(p, (stmt.moduleSpecifier as ts.StringLiteral).text, allPaths, srcPrefix);
      if (resolved) edges.push(resolved);
    }
    graph.set(p, edges);
  }
  return graph;
}

function hasRealClientImportPath(targetPath: string, importGraph: ReadonlyMap<string, string[]>, clientPaths: ReadonlySet<string>): boolean {
  const visited = new Set<string>();
  const queue = [...clientPaths];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || visited.has(cur)) continue;
    if (cur === targetPath) return true;
    visited.add(cur);
    queue.push(...(importGraph.get(cur) ?? []));
  }
  return false;
}

function detectMissingServerOnly(sources: ReadonlyMap<string, ts.SourceFile>, srcPrefix: string): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const clientPaths = new Set([...sources].filter(([, sf]) => leadingDirective(sf) === "use client").map(([p]) => p));
  const importGraph = buildImportGraph(sources, srcPrefix);

  for (const [p, sf] of sources) {
    if (leadingDirective(sf) !== undefined) continue; // 'use client'/'use server' — compiler-enforced boundaries
    if (SERVER_ONLY_EXEMPT_PATTERN.test(p)) continue; // route handlers / middleware are server-exclusive by convention
    if (hasServerOnlyImport(sf)) continue;
    const secretNode = findSecretEnvAccess(sf);
    if (!secretNode) continue;
    if (!hasRealClientImportPath(p, importGraph, clientPaths)) continue;
    findings.push({
      kind: "missing-server-only",
      key: `missing-server-only::${p}`,
      file: p,
      line: lineOf(sf, secretNode),
      detail: `reads ${secretNode.getText(sf)} with no \`import "server-only"\` and IS reachable from a 'use client' file — add the poison-pill`,
    });
  }
  return findings;
}

export function scanSources(files: { rel: string; text: string }[], srcPrefix: string): BoundaryFinding[] {
  const sources = new Map(files.map((f) => [f.rel, parse(f.rel, f.text)]));
  return [...detectServerClientLeak(sources, srcPrefix), ...detectMissingServerOnly(sources, srcPrefix)];
}

// --- baseline plumbing (house FREEZE-EXISTING / BLOCK-NEW pattern) -----------

export function loadBaseline(file: string = BASELINE_FILE): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(file)) return map;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    const count = Number(line.slice(0, sp));
    const key = line.slice(sp + 1);
    if (Number.isFinite(count) && count > 0 && key) map.set(key, count);
  }
  return map;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(full);
  }
  return out;
}

function main(): void {
  const srcDir = path.resolve(process.argv[2] ?? path.join(ROOT, "apps/main/src"));
  const srcPrefix = path.relative(ROOT, srcDir).split(path.sep).join("/");
  const files = walk(srcDir).map((abs) => ({
    rel: path.relative(ROOT, abs).split(path.sep).join("/"),
    text: fs.readFileSync(abs, "utf8"),
  }));
  if (files.length === 0) {
    console.error("app-router-boundaries guard: no source files found — check paths.");
    process.exit(1);
  }

  const findings = scanSources(files, srcPrefix);
  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.key, (liveCounts.get(f.key) ?? 0) + 1);

  const baseline = loadBaseline();
  const fresh: BoundaryFinding[] = [];
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    if (n > (baseline.get(f.key) ?? 0)) fresh.push(f);
  }
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key) ?? 0) < based);

  if (fresh.length > 0) {
    console.error("app-router-boundaries guard: NEW server→client boundary finding(s):\n");
    for (const f of fresh) console.error(`  [${f.kind}] ${f.file}:${f.line}  ${f.detail}`);
    console.error(`\n${fresh.length} NEW finding(s) beyond scripts/app-router-boundaries-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`app-router-boundaries guard passed: ${files.length} file(s) scanned, ${findings.length} baselined finding(s), 0 new${note}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
