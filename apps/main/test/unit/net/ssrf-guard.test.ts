// F-ssrf-01 — the outbound-fetch SSRF guard. Pins the static scheme/host
// classification, the DNS-resolution screen (public name → private A record),
// and the DNS-pinned connection (#1402 — rebinding TOCTOU fix).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

// Mock node:http and node:https so fetchPinnedHop doesn't make real network calls.
// Each test controls the response via mockHopSequence.
const httpMockRequests: Array<{ status: number; headers: Record<string, string>; body?: string }> = [];
function makeMockReq(mockRes: { status: number; headers: Record<string, string>; body?: string }) {
  return (_opts: unknown, callback: (res: IncomingMessage) => void) => {
    const body = mockRes.body ?? "";
    const res = {
      statusCode: mockRes.status,
      headers: mockRes.headers,
      on: (event: string, handler: (arg?: unknown) => void) => {
        if (event === "data") handler(Buffer.from(body));
        if (event === "end") handler();
        return res;
      },
    };
    Promise.resolve().then(() => callback(res as unknown as IncomingMessage));
    return { setTimeout: () => {}, on: () => {}, end: () => {}, destroy: () => {} };
  };
}
vi.mock("node:http", () => ({
  request: vi.fn((opts: unknown, cb: (res: IncomingMessage) => void) => makeMockReq(httpMockRequests.shift()!)(opts, cb)),
}));
vi.mock("node:https", () => ({
  request: vi.fn((opts: unknown, cb: (res: IncomingMessage) => void) => makeMockReq(httpMockRequests.shift()!)(opts, cb)),
}));

import { lookup } from "node:dns/promises";
import {
  validateOutboundUrlStatic,
  validateOutboundUrlResolved,
  fetchGuarded,
  SsrfBlockedError,
} from "@/lib/net/ssrf-guard";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.clearAllMocks());

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

  it("allows a public name resolving to public IPs and returns the pinned address", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const r = await validateOutboundUrlResolved("https://feeds.example.com/rss");
    expect(r.allowed).toBe(true);
    // pinnedIp is returned so fetchGuarded can connect to it directly (#1402 rebinding fix).
    expect(r.pinnedIp).toBe("93.184.216.34");
    expect(r.pinnedFamily).toBe(4);
  });

  it("short-circuits on a statically-bad URL without resolving", async () => {
    vi.mocked(lookup).mockClear();
    const r = await validateOutboundUrlResolved("http://169.254.169.254/");
    expect(r.allowed).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("fetchGuarded — per-hop SSRF validation + DNS-pinned connection", () => {
  it("rejects a redirect into an internal address before making the second hop", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    // First hop returns a 302 into an IMDS address. Static check on the Location
    // blocks before the second request fires.
    httpMockRequests.push({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    await expect(fetchGuarded("https://feeds.example.com/rss")).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(httpMockRequests).toHaveLength(0);
  });

  it("follows a redirect to another public host and returns the final response", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 301, headers: { location: "https://cdn.example.com/final" } });
    httpMockRequests.push({ status: 200, headers: {}, body: "ok" });
    const res = await fetchGuarded("https://feeds.example.com/rss");
    expect(res.status).toBe(200);
    expect(httpMockRequests).toHaveLength(0);
  });

  it("calls DNS lookup exactly once per hop — not again at connection time (rebinding fix)", async () => {
    // WHY: if lookup() were called again at connect time, a DNS rebind (public → private)
    // in the window between check and connect could redirect to an internal host.
    // With the pinned-IP lookup override, the kernel never re-resolves the hostname.
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 200, headers: {}, body: "data" });
    await fetchGuarded("https://feeds.example.com/rss");
    // dns.lookup must have been called exactly once — the SSRF check — not for the connection.
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
