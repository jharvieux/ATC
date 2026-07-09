// Lifecycle-script supply-chain guard (#1636).
//
// The Shai-Hulud pattern: a legitimate, already-reviewed package ships a
// malicious preinstall/postinstall in a LATER version. A reviewer approving a
// routine version bump won't notice a new install hook buried in a transitive
// dependency — pnpm-lock.yaml doesn't even record script content, so the diff
// is invisible in review.
//
// This scans the installed pnpm store for packages that define a
// preinstall/install/postinstall/prepare script and keys each by
// `<name>::<script>::<sha1(content)>` — VERSION-INDEPENDENT on purpose: a
// version bump that keeps the same hook passes silently (no churn), while a NEW
// or CHANGED hook produces a key absent from the baseline and fails the PR.
// Accepting a change means reviewing the script and adding its key to
// scripts/lifecycle-scripts-baseline.txt.
//
// Runs after `pnpm install` (node_modules must exist) — in pnpm verify and the
// Guards & Build CI job.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/lifecycle-scripts-baseline.txt");
const STORE = path.join(ROOT, "node_modules/.pnpm");

// preinstall/install/postinstall execute on install (the real attack surface);
// prepare is included per #1636 though it does not run from a registry tarball.
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare"] as const;

export interface Hook {
  name: string;
  script: string; // which lifecycle hook
  content: string; // the command
  key: string; // name::script::sha1
}

function keyFor(name: string, script: string, content: string): string {
  const h = crypto.createHash("sha1").update(content).digest("hex").slice(0, 12);
  return `${name}::${script}::${h}`;
}

// Exported for tests — pure over a list of manifest objects.
export function hooksFromManifest(pkg: {
  name?: unknown;
  scripts?: Record<string, unknown>;
}): Hook[] {
  const out: Hook[] = [];
  if (typeof pkg.name !== "string" || !pkg.scripts) return out;
  for (const script of LIFECYCLE) {
    const content = pkg.scripts[script];
    if (typeof content === "string" && content.trim()) {
      out.push({ name: pkg.name, script, content, key: keyFor(pkg.name, script, content) });
    }
  }
  return out;
}

// Walk the .pnpm virtual store: .pnpm/<pkg@ver>/node_modules/<pkg>/package.json
// (scoped packages nest one level deeper under @scope/).
function scanStore(store: string): Hook[] {
  const out: Hook[] = [];
  if (!fs.existsSync(store)) return out;
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nm = path.join(store, entry.name, "node_modules");
    if (!fs.existsSync(nm)) continue;
    for (const pkgDir of fs.readdirSync(nm, { withFileTypes: true })) {
      if (!pkgDir.isDirectory()) continue;
      const candidates = pkgDir.name.startsWith("@")
        ? fs
            .readdirSync(path.join(nm, pkgDir.name), { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => path.join(nm, pkgDir.name, d.name))
        : [path.join(nm, pkgDir.name)];
      for (const dir of candidates) {
        const manifest = path.join(dir, "package.json");
        if (!fs.existsSync(manifest)) continue;
        try {
          out.push(...hooksFromManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))));
        } catch {
          // Unparseable manifest — skip; not our concern here.
        }
      }
    }
  }
  return out;
}

const BASELINE_HEADER = [
  "# Lifecycle-script supply-chain baseline (scripts/check-lifecycle-scripts.ts, #1636).",
  "# One recognized install hook per line, keyed <name>::<script>::<sha1(content)>.",
  "# Keyed by CONTENT HASH, not version — a routine version bump that keeps the same",
  "# hook passes silently; a NEW or CHANGED preinstall/install/postinstall/prepare",
  "# produces an unknown key and fails the PR. Add a line ONLY after reviewing the",
  "# script (Shai-Hulud risk). Regenerate with: pnpm tsx scripts/check-lifecycle-scripts.ts --dump",
].join("\n");

// --dump output: the header + every current hook key, deduped and sorted, so
// `… --dump > scripts/lifecycle-scripts-baseline.txt` regenerates the file after
// a reviewed change. Exported (pure over a Hook list) so a test can pin it.
export function formatBaseline(hooks: Hook[]): string {
  const keys = [...new Set(hooks.map((h) => h.key))].sort();
  return [BASELINE_HEADER, ...keys].join("\n") + "\n";
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main(): void {
  if (!fs.existsSync(STORE)) {
    console.error("Lifecycle-script guard: node_modules/.pnpm not found. Run `pnpm install` first.");
    process.exit(1);
  }
  if (process.argv.includes("--dump")) {
    process.stdout.write(formatBaseline(scanStore(STORE)));
    return;
  }
  const baseline = loadBaseline();
  const hooks = scanStore(STORE);
  const byKey = new Map<string, Hook>();
  for (const h of hooks) if (!byKey.has(h.key)) byKey.set(h.key, h);

  const fresh = [...byKey.values()].filter((h) => !baseline.has(h.key));
  if (fresh.length > 0) {
    console.error(
      "Lifecycle-script guard: NEW or CHANGED install hook(s) not in the baseline:\n",
    );
    for (const h of fresh) {
      const snippet = h.content.length > 100 ? h.content.slice(0, 100) + "…" : h.content;
      console.error(`  ${h.name} [${h.script}]: ${snippet}`);
      console.error(`    key: ${h.key}`);
    }
    console.error(
      `\n${fresh.length} unrecognized hook(s). REVIEW each script (Shai-Hulud supply-chain risk). ` +
        "If benign, add its `key` line to scripts/lifecycle-scripts-baseline.txt. Never baseline blindly.",
    );
    process.exit(1);
  }

  const stale = [...baseline].filter((k) => !byKey.has(k));
  const note = stale.length > 0 ? ` (${stale.length} stale baseline entr(y/ies) — trim after review)` : "";
  console.log(
    `Lifecycle-script guard passed: ${byKey.size} install hook(s) recognized, 0 new` + note + ".",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
