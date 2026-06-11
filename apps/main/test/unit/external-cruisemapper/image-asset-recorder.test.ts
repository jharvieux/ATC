// BP37 §33.6.3 — image-asset recorder host allowlist tests.
// §953 Phase A — recordCabinImage entity-id + kind-selection tests.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { _isHostAllowedForTests, recordCabinImage } from "../../../src/lib/external/cruisemapper/image-asset-recorder";

const mocks = vi.hoisted(() => ({
  signServiceJwt: vi.fn().mockResolvedValue("fake.jwt.token"),
}));

vi.mock("../../../src/lib/rag-auth/sign-service-jwt", () => ({
  signServiceJwt: mocks.signServiceJwt,
}));

vi.mock("../../../src/lib/rag-auth/platform-sentinel", () => ({
  PLATFORM_SENTINEL_TENANT_ID: "00000000-0000-0000-0000-000000000000",
}));

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

describe("recordCabinImage — entity-id and kind selection (§953)", () => {
  let lastPayload: Record<string, unknown> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("RAG_SERVICE_URL", "https://rag.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ asset_id: "asset-abc123" }),
    }));
  });

  it("sends kind=cabin_plan for imageType=floor_plan", async () => {
    const out = await recordCabinImage({
      imageUrl: "https://www.cruisemapper.com/images/cabins/2216c841be4f85b.gif",
      sourcePageUrl: "https://www.cruisemapper.com/cabins/Norwegian-Prima-2216",
      shipSlug: "Norwegian-Prima-2216",
      categoryName: "The Haven Premier Owner Suite",
      imageType: "floor_plan",
    });
    expect(out.status).toBe("recorded");
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    lastPayload = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(lastPayload.kind).toBe("cabin_plan");
  });

  it("sends kind=cabin_photo for imageType=photo", async () => {
    await recordCabinImage({
      imageUrl: "https://www.cruisemapper.com/images/cabins/pictures/2216C-5043-90c314a.jpg",
      sourcePageUrl: "https://www.cruisemapper.com/cabins/Norwegian-Prima-2216",
      shipSlug: "Norwegian-Prima-2216",
      categoryName: "The Haven Premier Owner Suite",
      imageType: "photo",
    });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(call[1].body as string) as Record<string, unknown>;
    expect(payload.kind).toBe("cabin_photo");
  });

  it("constructs entity_id as <shipSlug>-cabin-<lowercased-slugified-category>", async () => {
    await recordCabinImage({
      imageUrl: "https://www.cruisemapper.com/images/cabins/2216c841be4f85b.gif",
      sourcePageUrl: "https://www.cruisemapper.com/cabins/Norwegian-Prima-2216",
      shipSlug: "Norwegian-Prima-2216",
      categoryName: "3-Bedroom The Haven Premier Owner Suite with Balcony Jacuzzi",
      imageType: "floor_plan",
    });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = JSON.parse(call[1].body as string) as Record<string, unknown>;
    // Category name lowercased + non-alnum chars → hyphens, trimmed.
    expect(payload.entity_id).toBe(
      "Norwegian-Prima-2216-cabin-3-bedroom-the-haven-premier-owner-suite-with-balcony-jacuzzi"
    );
  });

  it("returns skipped for a non-allowlisted image URL without calling RAG", async () => {
    const out = await recordCabinImage({
      imageUrl: "https://evil.com/fake.gif",
      sourcePageUrl: "https://www.cruisemapper.com/cabins/Norwegian-Prima-2216",
      shipSlug: "Norwegian-Prima-2216",
      categoryName: "Studio",
      imageType: "floor_plan",
    });
    expect(out.status).toBe("skipped");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
