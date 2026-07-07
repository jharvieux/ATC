// Help-screenshot drift gate.
//
// Keeps three things in lockstep — the screenshot manifest
// (scripts/help-screenshots/manifest.ts), the generated PNGs
// (apps/main/public/help/**), and the docs that reference them
// (apps/main/content/help/*.md). Any one moving without the others is a
// broken image or a stale screenshot waiting to ship to customers.
//
// FAILS on:
//   - a doc referencing /help/<...>.png with no file on disk
//   - a doc referencing /help/<...>.png with no manifest entry (hand-placed
//     image — it can never be regenerated; add a Shot entry instead)
//   - a /help/ image with empty alt text (alt is what the Help AI's RAG
//     ingest and screen readers see — it is not optional)
//   - a manifest entry whose PNG is missing (capture not re-run)
//   - a PNG on disk no doc references (orphan)
//   - a manifest entry whose doc slug matches no help doc, or a callout
//     annotation without `n`
// WARNS on:
//   - remaining unfilled "[Screenshot: ...]" placeholders

import * as fs from "node:fs";
import * as path from "node:path";
import { SHOTS } from "./help-screenshots/manifest";

const DOCS_DIR = path.join("apps", "main", "content", "help");
const IMG_ROOT = path.join("apps", "main", "public", "help");

const errors: string[] = [];
const warnings: string[] = [];

// --- collect doc slugs + image references ---------------------------------
const docFiles = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
const slugs = new Set<string>();
/** map of "<doc>/<id>.png" (path under public/help) → referencing doc file */
const referenced = new Map<string, string>();

for (const file of docFiles) {
  const text = fs.readFileSync(path.join(DOCS_DIR, file), "utf8");
  const slug = /^slug:\s*(\S+)/m.exec(text)?.[1];
  if (slug) slugs.add(slug);

  for (const m of text.matchAll(/!\[([^\]]*)\]\((\/help\/[^)\s]+)\)/g)) {
    const [, alt, src] = m;
    const rel = src.replace(/^\/help\//, "");
    referenced.set(rel, file);
    if (alt.trim().length === 0) {
      errors.push(`${file}: image ${src} has empty alt text`);
    }
    if (!fs.existsSync(path.join(IMG_ROOT, rel))) {
      errors.push(`${file}: references ${src} but apps/main/public/help/${rel} does not exist`);
    }
  }

  for (const m of text.matchAll(/^\[Screenshot:([^\]]*)\]/gm)) {
    warnings.push(`${file}: unfilled placeholder [Screenshot:${m[1]}]`);
  }
}

// --- manifest internal consistency + manifest → files ----------------------
const manifestOutputs = new Set<string>();
for (const shot of SHOTS) {
  const rel = `${shot.doc}/${shot.id}.png`;
  manifestOutputs.add(rel);
  if (!slugs.has(shot.doc)) {
    errors.push(`manifest: shot "${rel}" targets doc slug "${shot.doc}" which matches no help doc`);
  }
  if (!fs.existsSync(path.join(IMG_ROOT, rel))) {
    errors.push(`manifest: shot "${rel}" has no captured PNG — run \`pnpm help:screenshots -- --doc ${shot.doc}\``);
  }
  for (const a of shot.annotations ?? []) {
    if (a.type === "callout" && typeof a.n !== "number") {
      errors.push(`manifest: shot "${rel}" has a callout annotation without \`n\``);
    }
  }
}

// --- files → docs + manifest -----------------------------------------------
if (fs.existsSync(IMG_ROOT)) {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const abs of walk(IMG_ROOT)) {
    const rel = path.relative(IMG_ROOT, abs).split(path.sep).join("/");
    if (!referenced.has(rel)) errors.push(`orphan image: public/help/${rel} is referenced by no help doc`);
    if (!manifestOutputs.has(rel)) {
      errors.push(`hand-placed image: public/help/${rel} has no manifest entry, so it can't be regenerated`);
    }
  }
}

// referenced-but-unmanifested (covers refs whose file also doesn't exist yet)
for (const [rel, file] of referenced) {
  if (!manifestOutputs.has(rel)) {
    errors.push(`${file}: /help/${rel} has no entry in scripts/help-screenshots/manifest.ts`);
  }
}

// --- report -----------------------------------------------------------------
for (const w of warnings) console.warn(`WARN  ${w}`);
if (warnings.length > 0) {
  console.warn(`\n${warnings.length} unfilled screenshot placeholder(s) remain (not blocking).`);
}
if (errors.length > 0) {
  console.error(`\ncheck:help-screenshots FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`check:help-screenshots OK — ${manifestOutputs.size} manifest shot(s), ${referenced.size} doc reference(s).`);
