// BP37 §33.6.3 — image-asset recorder host allowlist tests.

import { describe, expect, it } from "vitest";
import { _isHostAllowedForTests } from "../../../src/lib/external/cruisemapper/image-asset-recorder";

describe("isHostAllowed", () => {
  it("allows cruisemapper.com and known CDN", () => {
    expect(_isHostAllowedForTests("https://www.cruisemapper.com/images/x.jpg").allowed).toBe(true);
    expect(_isHostAllowedForTests("https://cruisemapper.com/images/x.png").allowed).toBe(true);
    expect(_isHostAllowedForTests("https://cdn.cruisemapper.com/x.webp").allowed).toBe(true);
  });

  it("rejects non-allowlisted hosts", () => {
    expect(_isHostAllowedForTests("https://evil.com/x.jpg").allowed).toBe(false);
    expect(_isHostAllowedForTests("https://imgur.com/abc.jpg").allowed).toBe(false);
  });

  it("rejects loopback / private IP literals", () => {
    expect(_isHostAllowedForTests("http://127.0.0.1/x.jpg").allowed).toBe(false);
    expect(_isHostAllowedForTests("http://192.168.1.1/x.jpg").allowed).toBe(false);
    expect(_isHostAllowedForTests("http://10.0.0.1/x.jpg").allowed).toBe(false);
    expect(_isHostAllowedForTests("http://169.254.0.1/x.jpg").allowed).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(_isHostAllowedForTests("ftp://cruisemapper.com/x.jpg").allowed).toBe(false);
    expect(_isHostAllowedForTests("javascript:alert(1)").allowed).toBe(false);
    expect(_isHostAllowedForTests("data:image/png;base64,xxx").allowed).toBe(false);
  });

  it("rejects URLs without a known image extension", () => {
    expect(_isHostAllowedForTests("https://www.cruisemapper.com/page").allowed).toBe(false);
    expect(_isHostAllowedForTests("https://www.cruisemapper.com/x.svg").allowed).toBe(false);
  });

  it("accepts image URLs with query strings", () => {
    expect(_isHostAllowedForTests("https://www.cruisemapper.com/x.jpg?v=2").allowed).toBe(true);
  });

  it("accepts .gif deck-plan images — the real CruiseMapper format (#768)", () => {
    // CruiseMapper serves deck plans as .gif; before #768 the extension
    // allowlist omitted gif, so every deck image was rejected here.
    expect(_isHostAllowedForTests("https://www.cruisemapper.com/images/deckplans/1355a0a74af575c.gif").allowed).toBe(true);
  });
});
