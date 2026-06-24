// F-ssrf-01 — the outbound-fetch SSRF guard. Pins the static scheme/host
// classification and the DNS-resolution screen (public name → private A record).

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import {
  validateOutboundUrlStatic,
  validateOutboundUrlResolved,
  fetchGuarded,
  SsrfBlockedError,
} from "@/lib/net/ssrf-guard";

afterEach(() => vi.restoreAllMocks());

describe("validateOutboundUrlStatic", () => {
  it("rejects unsafe schemes, internal hosts, and garbage", () => {
    for (const u of [
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://127.0.0.1/",
      "http://localhost/",
      "http://intranet/",
      "not a url",
    ]) {
      expect(validateOutboundUrlStatic(u).allowed).toBe(false);
    }
  });

  it("allows ordinary public http(s) URLs", () => {
    expect(validateOutboundUrlStatic("https://feeds.example.com/rss").allowed).toBe(true);
    expect(validateOutboundUrlStatic("http://cdn.example.com:8080/x").allowed).toBe(true);
  });
});

describe("validateOutboundUrlResolved — DNS screen", () => {
  it("rejects a public name that resolves to an internal IP", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as never);
    const r = await validateOutboundUrlResolved("https://evil.example.com/rss");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("resolves_to_internal");
  });

  it("allows a public name resolving to public IPs", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const r = await validateOutboundUrlResolved("https://feeds.example.com/rss");
    expect(r.allowed).toBe(true);
  });

  it("short-circuits on a statically-bad URL without resolving", async () => {
    vi.mocked(lookup).mockClear();
    const r = await validateOutboundUrlResolved("http://169.254.169.254/");
    expect(r.allowed).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("fetchGuarded — re-screens every redirect hop", () => {
  it("rejects a redirect from a public host into an internal address (no fetch of the internal target)", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    await expect(fetchGuarded("https://feeds.example.com/rss")).rejects.toBeInstanceOf(SsrfBlockedError);
    // The internal Location is caught by the static re-check before a second fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public host and returns the final response", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://cdn.example.com/final" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const res = await fetchGuarded("https://feeds.example.com/rss");
    expect(res.status).toBe(200);
  });
});
