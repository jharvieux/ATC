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
import { SHOTS, type Shot } from "./help-screenshots/manifest";

const DOCS_DIR = path.join("apps", "main", "content", "help");
const IMG_ROOT = path.join("apps", "main", "public", "help");

export interface ScanInput {
  /** doc file name → raw markdown (front-matter included) */
  docs: Map<string, string>;
  /** paths of existing PNGs relative to public/help, "/"-separated */
  images: Set<string>;
  shots: Pick<Shot, "doc" | "id" | "annotations">[];
}

export interface ScanResult {
  errors: string[];
  warnings: string[];
}

export function scanHelpScreenshots({ docs, images, shots }: ScanInput): ScanResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const slugs = new Set<string>();
  /** "<doc>/<id>.png" → referencing doc file */
  const referenced = new Map<string, string>();

  for (const [file, text] of docs) {
    const slug = /^slug:\s*(\S+)/m.exec(text)?.[1];
    if (slug) slugs.add(slug);

    for (const m of text.matchAll(/!\[([^\]]*)\]\((\/help\/[^)\s]+)\)/g)) {
      const [, alt, src] = m;
      const rel = src.replace(/^\/help\//, "");
      referenced.set(rel, file);
      if (alt.trim().length === 0) {
        errors.push(`${file}: image ${src} has empty alt text`);
      }
      if (!images.has(rel)) {
        errors.push(`${file}: references ${src} but apps/main/public/help/${rel} does not exist`);
      }
    }

    for (const m of text.matchAll(/^\[Screenshot:([^\]]*)\]/gm)) {
      warnings.push(`${file}: unfilled placeholder [Screenshot:${m[1]}]`);
    }
  }

  const manifestOutputs = new Set<string>();
  for (const shot of shots) {
    const rel = `${shot.doc}/${shot.id}.png`;
    manifestOutputs.add(rel);
    if (!slugs.has(shot.doc)) {
      errors.push(`manifest: shot "${rel}" targets doc slug "${shot.doc}" which matches no help doc`);
    }
    if (!images.has(rel)) {
      errors.push(`manifest: shot "${rel}" has no captured PNG — run \`pnpm help:screenshots -- --doc ${shot.doc}\``);
    }
    for (const a of shot.annotations ?? []) {
      if (a.type === "callout" && typeof a.n !== "number") {
        errors.push(`manifest: shot "${rel}" has a callout annotation without \`n\``);
      }
    }
  }

  for (const rel of images) {
    if (!referenced.has(rel)) errors.push(`orphan image: public/help/${rel} is referenced by no help doc`);
    if (!manifestOutputs.has(rel)) {
      errors.push(`hand-placed image: public/help/${rel} has no manifest entry, so it can't be regenerated`);
    }
  }

  // referenced-but-unmanifested (covers refs whose file also doesn't exist yet)
  for (const [rel, file] of referenced) {
    if (!manifestOutputs.has(rel)) {
      errors.push(`${file}: /help/${rel} has no entry in scripts/help-screenshots/manifest.ts`);
    }
  }

  return { errors, warnings };
}

function main(): void {
  const docs = new Map<string, string>();
  for (const f of fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"))) {
    docs.set(f, fs.readFileSync(path.join(DOCS_DIR, f), "utf8"));
  }

  const images = new Set<string>();
  if (fs.existsSync(IMG_ROOT)) {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else images.add(path.relative(IMG_ROOT, abs).split(path.sep).join("/"));
      }
    };
    walk(IMG_ROOT);
  }

  const { errors, warnings } = scanHelpScreenshots({ docs, images, shots: SHOTS });

  for (const w of warnings) console.warn(`WARN  ${w}`);
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} unfilled screenshot placeholder(s) remain (not blocking).`);
  }
  if (errors.length > 0) {
    console.error(`\ncheck:help-screenshots FAILED (${errors.length}):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`check:help-screenshots OK — ${SHOTS.length} manifest shot(s), ${images.size} image(s).`);
}

// Only run when invoked directly (`tsx scripts/check-help-screenshots.ts`);
// importing the module for unit tests must NOT trigger the repo scan or exit.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
