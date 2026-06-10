// #904 / D-194 — email-file parsing against REAL fixtures.
// The .eml is hand-authored (text format) including an RFC 2047 encoded-word
// From — the encoding class that silently breaks hand-rolled parsers. The
// .msg is a genuine Outlook CDFV2 binary vendored from the msgreader test
// suite (Apache-2.0, github.com/HiraokaHyperTools/msgreader) because that
// format cannot be honestly fabricated by hand.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseEmlFile, parseMsgFile } from "@/lib/draft/parse-inquiry";

const FIXTURES = join(process.cwd(), "apps", "main", "test", "fixtures", "draft");

function fixtureBuf(name: string): ArrayBuffer {
  const b = readFileSync(join(FIXTURES, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const EML = [
  "From: =?UTF-8?Q?Sarah_Mitch=C3=A8ll?= <sarah.mitchell@example.com>",
  "To: agent@agency.example",
  "Subject: Caribbean trip in July?",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi! We're thinking about a Caribbean cruise in July for our anniversary.",
  "What would you recommend?",
  "",
].join("\r\n");

describe("parseEmlFile (#904)", () => {
  it("parses From (incl. RFC 2047 encoded-word display name), Subject, body", async () => {
    const parsed = await parseEmlFile(new TextEncoder().encode(EML).buffer as ArrayBuffer);
    expect(parsed.from_name).toBe("Sarah Mitchèll");
    expect(parsed.from_email).toBe("sarah.mitchell@example.com");
    expect(parsed.subject).toBe("Caribbean trip in July?");
    expect(parsed.body).toContain("anniversary");
  });
});

describe("parseMsgFile (#904 / D-194)", () => {
  it("parses a genuine Outlook .msg: subject + body extracted", async () => {
    const parsed = await parseMsgFile(fixtureBuf("msgreader-test1.msg"));
    expect(parsed.subject).toBe("title");
    expect(parsed.body).toContain("body");
  });

  it("fixture has no sender — fields are null, not invented (the TA fills the name)", async () => {
    const parsed = await parseMsgFile(fixtureBuf("msgreader-test1.msg"));
    expect(parsed.from_name).toBeNull();
    expect(parsed.from_email).toBeNull();
  });
});
