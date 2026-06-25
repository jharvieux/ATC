// #1387 / F-inp-02 — unit tests for the ZIP bomb pre-check in extract-content.
//
// Pins WHY the check exists: mammoth/exceljs/officeparser fully decompress
// OOXML ZIPs in memory; a high-ratio archive (~50MB → GBs) OOMs the
// serverless function before any output cap runs. The central-directory
// pre-check rejects oversized archives before the parser ever starts.
//
// Tests the exported checkZipBomb function directly with synthetic ZIP buffers
// whose central-directory records declare controlled uncompressed sizes.

import { describe, it, expect } from "vitest";
import { checkZipBomb } from "../../apps/main/src/lib/rag-ingest/extract-content";

// ── Minimal ZIP builder ─────────────────────────────────────────────────────
// Builds a structurally valid ZIP with N entries, each claiming a controlled
// uncompressed size. The compressed data bytes are zero-filled stubs — we
// don't need real content because checkZipBomb only reads the CD headers.

function buildZip(entries: Array<{ uncompressedSize: number; compressedSize?: number }>): ArrayBuffer {
  const FILENAME = "x";
  const fnLen = FILENAME.length;

  const localHeaders: Buffer[] = [];
  const cdEntries: Buffer[] = [];
  let localOffset = 0;

  for (const { uncompressedSize, compressedSize = 8 } of entries) {
    const lh = Buffer.alloc(30 + fnLen + compressedSize);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(compressedSize, 18);
    lh.writeUInt32LE(uncompressedSize, 22);
    lh.writeUInt16LE(fnLen, 26);
    lh.write(FILENAME, 30);
    localHeaders.push(lh);

    const cd = Buffer.alloc(46 + fnLen);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(compressedSize, 20);
    cd.writeUInt32LE(uncompressedSize, 24);
    cd.writeUInt16LE(fnLen, 28);
    cd.writeUInt32LE(localOffset, 42);
    cd.write(FILENAME, 46);
    cdEntries.push(cd);

    localOffset += lh.length;
  }

  const cdBuf = Buffer.concat(cdEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  const buf = Buffer.concat([...localHeaders, cdBuf, eocd]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("checkZipBomb", () => {
  it("returns null (safe) for an empty non-ZIP buffer", () => {
    expect(checkZipBomb(new ArrayBuffer(4))).toBeNull();
  });

  it("returns null for a ZIP whose total uncompressed size is within 100MB", () => {
    const safe = buildZip([{ uncompressedSize: 50 * 1024 * 1024 }]); // 50MB
    expect(checkZipBomb(safe)).toBeNull();
  });

  it("flags a ZIP where a single entry exceeds 100MB", () => {
    const bomb = buildZip([{ uncompressedSize: 101 * 1024 * 1024 }]);
    expect(checkZipBomb(bomb)).toMatch(/zip_bomb/);
  });

  it("flags a ZIP where the sum across multiple entries exceeds 100MB", () => {
    // Each entry claims 30MB; 4 entries = 120MB total → bomb
    const bomb = buildZip(Array.from({ length: 4 }, () => ({ uncompressedSize: 30 * 1024 * 1024 })));
    expect(checkZipBomb(bomb)).toMatch(/zip_bomb/);
  });

  it("does NOT flag when cumulative size is exactly 100MB (boundary)", () => {
    const exactly = buildZip([{ uncompressedSize: 100 * 1024 * 1024 }]);
    expect(checkZipBomb(exactly)).toBeNull();
  });

  it("returns null for a plain text buffer (not a ZIP)", () => {
    const text = Buffer.from("hello world this is not a zip file");
    expect(checkZipBomb(text.buffer.slice(text.byteOffset, text.byteOffset + text.byteLength))).toBeNull();
  });

  it("flags a ZIP64 entry whose uncompressed-size field is 0xFFFFFFFF (sentinel)", () => {
    // ZIP64 archives use 0xFFFFFFFF in the 32-bit CD field as a sentinel; the real
    // size lives in a zip64 extra field we don't parse. Fail closed on the sentinel.
    const zip64 = buildZip([{ uncompressedSize: 0xFFFFFFFF }]);
    expect(checkZipBomb(zip64)).toMatch(/zip64/);
  });
});
