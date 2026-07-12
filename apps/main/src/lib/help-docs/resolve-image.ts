/**
 * BP31 §32.3.3 — Resolve help-doc markdown image srcs (`/help/...`) to
 * local file bytes for the PDF/Word export path (#1688).
 *
 * The export Inngest worker has no browser origin to resolve a relative
 * img src against, so it reads the file straight off the `public/` dir
 * that serves it instead of fetching a URL.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

export interface ResolvedHelpImage {
  data: Buffer;
  type: "png" | "jpg" | "gif" | "bmp";
}

const EXT_TO_TYPE: Record<string, ResolvedHelpImage["type"]> = {
  ".png": "png",
  ".jpg": "jpg",
  ".jpeg": "jpg",
  ".gif": "gif",
  ".bmp": "bmp",
};

// Same dual-cwd lookup as docs-loader.ts (Vitest runs from repo root,
// Next.js runs from apps/main).
function resolvePublicDir(): string {
  const candidates = [
    join(process.cwd(), "public"),
    join(process.cwd(), "apps", "main", "public"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

/** Resolve a help-doc markdown image src (e.g. `/help/images/foo.png`) to
 *  its bytes on disk. Returns null for unrecognized extensions or a
 *  missing file (e.g. a not-yet-backfilled screenshot) so callers can
 *  skip the image instead of crashing the export. */
export function resolveHelpImage(src: string): ResolvedHelpImage | null {
  const type = EXT_TO_TYPE[extname(src).toLowerCase()];
  if (!type || !src.startsWith("/")) return null;
  const filePath = join(resolvePublicDir(), src);
  if (!existsSync(filePath)) return null;
  return { data: readFileSync(filePath), type };
}

/** Parse a PNG's IHDR chunk for pixel dimensions. Returns null for
 *  non-PNG or malformed data. Used by the DOCX exporter, which — unlike
 *  react-pdf — requires explicit transformation dimensions per image. */
export function pngDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
