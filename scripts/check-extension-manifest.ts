// WebExtension manifest guard — Harvey Tier-1 port (refs #2000).
//
// Ported from Harvey src/scan/webext-manifest.ts @ 5b5aada, adapted for ATC
// (no Finding[] plumbing — repo check-script output/exit-code conventions).
//
// Flags a browser-extension manifest that declares a BROAD host pattern
// (<all_urls>, *://*/*, https://*/*) together with a SENSITIVE capability
// (cookies, webRequest, tabs, history, …): with broad hosts + cookies the
// extension can read auth/session cookies on EVERY site the user visits, not
// just the origin it needs — the exact shape Harvey flagged on apps/extension
// (host_permissions ["https://*/*"] + "cookies", refs #2000 / PR #2015).
//
// FREEZE-EXISTING / BLOCK-NEW: the pre-#2015 broad manifest is frozen in
// scripts/extension-manifest-baseline.txt until that PR merges; a NEW broad
// combo (new manifest, or new broad pattern / sensitive capability beyond the
// baselined count) fails. Fails loud when zero manifests are found.
//
// Usage: tsx scripts/check-extension-manifest.ts [manifest.json ...]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/extension-manifest-baseline.txt");

// A host match pattern covering effectively every site. V2 mixes host patterns
// into `permissions`; V3 splits them into `host_permissions`;
// content_scripts[].matches uses the same grammar.
const BROAD_HOST = /^(<all_urls>|\*|\*:\/\/\*\/?\*?|https?:\/\/\*\/?\*?)$/i;

// Capabilities that, combined with a broad host, expose cross-site data or
// control. `cookies` is the headline (session/auth-token read).
const SENSITIVE_CAPS = new Set([
  "cookies", "webrequest", "webrequestblocking", "tabs", "history", "webnavigation",
  "clipboardread", "management", "debugger", "proxy", "privacy", "browsingdata",
]);

interface WebExtManifest {
  manifest_version?: number;
  name?: string;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
}

export interface ManifestFinding {
  file: string;
  key: string; // <file>::<host-pattern>::<capability> — line-independent identity
  broadHost: string;
  capability: string;
}

// One finding per (broad host pattern × sensitive capability) pair, so
// narrowing the host OR dropping a capability shrinks the live count and a new
// broad pattern/capability exceeds the baseline.
export function findOverbroadCombos(relPath: string, json: string): ManifestFinding[] {
  let m: WebExtManifest;
  try {
    m = JSON.parse(json) as WebExtManifest;
  } catch {
    return []; // not JSON we can read — not a WebExtension manifest
  }
  if (typeof m.manifest_version !== "number") return []; // not a WebExtension manifest

  const perms = [...(m.permissions ?? []), ...(m.optional_permissions ?? [])];
  const hostPatterns = [
    ...(m.host_permissions ?? []),
    ...perms, // V2 host patterns live here alongside capability names
    ...(m.content_scripts ?? []).flatMap((cs) => cs.matches ?? []),
  ];
  const broadHosts = [...new Set(hostPatterns.filter((h) => typeof h === "string" && BROAD_HOST.test(h.trim())))];
  const sensitiveCaps = [...new Set(perms.filter((p) => typeof p === "string" && SENSITIVE_CAPS.has(p.toLowerCase())))];

  const out: ManifestFinding[] = [];
  for (const host of broadHosts) {
    for (const cap of sensitiveCaps) {
      out.push({ file: relPath, key: `${relPath}::${host}::${cap.toLowerCase()}`, broadHost: host, capability: cap });
    }
  }
  return out;
}

function findManifests(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git", "dist"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findManifests(p));
    else if (e.name === "manifest.json") out.push(p);
  }
  return out;
}

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

function main(): void {
  const args = process.argv.slice(2);
  const manifests = args.length > 0 ? args.map((a) => path.resolve(a)) : findManifests(path.join(ROOT, "apps"));
  if (manifests.length === 0) {
    console.error("extension-manifest guard: no manifest.json found under apps/ — check paths.");
    process.exit(1);
  }

  const findings = manifests.flatMap((abs) => findOverbroadCombos(path.relative(ROOT, abs), fs.readFileSync(abs, "utf8")));
  const baseline = loadBaseline();
  const liveCounts = new Map<string, number>();
  for (const f of findings) liveCounts.set(f.key, (liveCounts.get(f.key) ?? 0) + 1);
  const fresh = findings.filter((f) => (liveCounts.get(f.key) ?? 0) > (baseline.get(f.key) ?? 0));
  const stale = [...baseline].filter(([key, based]) => (liveCounts.get(key) ?? 0) < based);

  if (fresh.length > 0) {
    console.error(
      "extension-manifest guard: broad host access combined with a sensitive capability — scope" +
        " host_permissions/matches to the specific origin(s) the extension needs (activeTab /" +
        " optional_permissions for the rest):\n",
    );
    for (const f of fresh) console.error(`  ${f.file}: ${f.broadHost} + "${f.capability}"`);
    console.error(`\n${fresh.length} NEW combo(s) beyond scripts/extension-manifest-baseline.txt.`);
    process.exit(1);
  }
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim them)` : "";
  console.log(`extension-manifest guard passed: ${manifests.length} manifest(s) scanned, ${findings.length} baselined combo(s), 0 new${note}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
