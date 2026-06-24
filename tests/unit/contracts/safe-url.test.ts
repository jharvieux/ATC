// F-rag-pii-02 — safeUrl rejects URLs that would become an internal-network
// probe or unsafe-scheme link when a stored source_url/image_url is rendered
// into a client <img src>/<a href>. A regression here re-opens that egress.

import { describe, it, expect } from "vitest";
import { safeUrl } from "../../../packages/contracts/src/safe-url";

const ok = (u: string) => safeUrl.safeParse(u).success;

describe("safeUrl — rejects unsafe schemes", () => {
  it("blocks file:, data:, javascript:, gopher:, ftp:", () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "gopher://x/",
      "ftp://files.example.com/x",
    ]) {
      expect(ok(u)).toBe(false);
    }
  });
});

describe("safeUrl — rejects internal/loopback/link-local hosts", () => {
  it("blocks cloud metadata, loopback, RFC1918, CGNAT", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/",
      "http://10.0.0.5/",
      "http://172.16.5.5/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
    ]) {
      expect(ok(u)).toBe(false);
    }
  });

  it("blocks decimal/hex-encoded loopback and IPv6 internal forms", () => {
    for (const u of [
      "http://2130706433/", // decimal → 127.0.0.1
      "http://0x7f000001/", // full-word hex → 127.0.0.1
      "http://0x7f.0.0.1/", // per-octet hex → 127.0.0.1
      "http://[::1]/",
      "http://[fe80::1]/", // link-local
      "http://[fc00::1]/", // unique-local fc00::/7
      "http://[fd12::1]/", // unique-local
      "http://[::ffff:169.254.169.254]/", // v4-mapped metadata
    ]) {
      expect(ok(u)).toBe(false);
    }
  });

  it("blocks localhost and unqualified single-label hosts", () => {
    for (const u of ["http://localhost/", "http://api.localhost/", "http://intranet/", "http://db.internal/"]) {
      expect(ok(u)).toBe(false);
    }
  });
});

describe("safeUrl — allows ordinary public URLs", () => {
  it("accepts http(s) public hosts (with ports/paths)", () => {
    for (const u of [
      "https://example.com/a.jpg",
      "http://cdn.example.com:8080/img/x.png",
      "https://images.cruisemapper.com/ship/deck.jpg",
    ]) {
      expect(ok(u)).toBe(true);
    }
  });

  it("rejects non-URL garbage", () => {
    expect(ok("not a url")).toBe(false);
    expect(ok("")).toBe(false);
  });
});
