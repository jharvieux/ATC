// F-ssrf-01 — the outbound-fetch SSRF guard. Pins the static scheme/host
// classification, the DNS-resolution screen (public name → private A record),
// and the DNS-pinned connection (#1402 — rebinding TOCTOU fix).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";
import { gzipSync } from "node:zlib";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

// Mock node:http and node:https so fetchPinnedHop doesn't make real network calls.
// Each test controls the response via mockHopSequence.
const httpMockRequests: Array<{ status: number; headers: Record<string, string>; body?: string | Buffer }> = [];
// Records what each simulated request was actually built with — the request
// opts (method/headers) and whatever was passed to req.end(body) — so tests
// can assert body forwarding (#1597), not just the response side.
const httpMockCalls: Array<{ opts: { method?: string; headers?: Record<string, string> }; endBody: unknown }> = [];
function makeMockReq(mockRes: { status: number; headers: Record<string, string>; body?: string | Buffer }) {
  return (opts: unknown, callback: (res: IncomingMessage) => void) => {
    const body = mockRes.body ?? "";
    const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const res = {
      statusCode: mockRes.status,
      headers: mockRes.headers,
      on: (event: string, handler: (arg?: unknown) => void) => {
        if (event === "data") handler(bodyBuf);
        if (event === "end") handler();
        return res;
      },
      destroy: () => {},
    };
    Promise.resolve().then(() => callback(res as unknown as IncomingMessage));
    const call = { opts: opts as { method?: string; headers?: Record<string, string> }, endBody: undefined as unknown };
    httpMockCalls.push(call);
    return {
      setTimeout: () => {},
      on: () => {},
      end: (b?: unknown) => {
        call.endBody = b;
      },
      destroy: () => {},
    };
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
  ResponseTooLargeError,
} from "@/lib/net/ssrf-guard";

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  httpMockCalls.length = 0;
});

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

// #1597 — fetchGuarded reimplemented an HTTP client on raw node:http(s) and
// silently dropped any `body` (only method/headers/timeoutMs were forwarded),
// buffered responses with no size cap, and never decompressed gzip/br/deflate.
describe("fetchGuarded — body forwarding, size cap, decompression (#1597)", () => {
  it("forwards a POST body to the pinned hop instead of silently dropping it", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 200, headers: {}, body: "ok" });
    await fetchGuarded("https://api.example.com/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(httpMockCalls).toHaveLength(1);
    const call = httpMockCalls[0]!;
    expect(call.opts.method).toBe("POST");
    expect(Buffer.isBuffer(call.endBody)).toBe(true);
    expect((call.endBody as Buffer).toString("utf8")).toBe(JSON.stringify({ hello: "world" }));
    // A caller-omitted content-length must be filled in from the actual body
    // so the receiving server doesn't hang waiting for more bytes.
    expect(call.opts.headers?.["content-length"]).toBe(
      String(Buffer.byteLength(JSON.stringify({ hello: "world" }))),
    );
  });

  it("throws instead of silently dropping an unsupported body type", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    // No response queued — the body encoding must throw before any request fires.
    await expect(
      fetchGuarded("https://api.example.com/upload", {
        method: "POST",
        body: new Blob(["x"]) as unknown as BodyInit,
      }),
    ).rejects.toThrow(/unsupported body type/);
    expect(httpMockCalls).toHaveLength(0);
  });

  it("decompresses a gzip response body transparently", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const plaintext = "hello gzip world — this is the decompressed RSS payload";
    const gzipped = gzipSync(Buffer.from(plaintext, "utf8"));
    httpMockRequests.push({
      status: 200,
      headers: { "content-encoding": "gzip", "content-length": String(gzipped.length) },
      body: gzipped,
    });
    const res = await fetchGuarded("https://feeds.example.com/rss.gz");
    expect(await res.text()).toBe(plaintext);
    // Headers describing the (now-stripped) encoding must not survive, or a
    // caller re-checking content-encoding would try to decode it again.
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("rejects a response whose declared Content-Length exceeds the size cap", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const oversizeDeclared = 10 * 1024 * 1024 + 1;
    httpMockRequests.push({
      status: 200,
      headers: { "content-length": String(oversizeDeclared) },
      body: "irrelevant — rejected before body is read",
    });
    await expect(fetchGuarded("https://feeds.example.com/huge")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("rejects a response whose actual body exceeds the size cap even without an honest Content-Length", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const oversizeBody = Buffer.alloc(10 * 1024 * 1024 + 1, "a");
    // No content-length header — simulates a server that lies or omits it;
    // the running-total check during streaming must still catch this.
    httpMockRequests.push({ status: 200, headers: {}, body: oversizeBody });
    await expect(fetchGuarded("https://feeds.example.com/huge-chunked")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("still preserves existing SSRF pinning behavior with a POST body (#1402 stays green)", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    await expect(
      fetchGuarded("https://feeds.example.com/rss", { method: "POST", body: "x" }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(httpMockRequests).toHaveLength(0);
  });
});

// #1702 — a compressed response could decompress into something far larger than
// the raw-byte cap ever sees. The zlib maxOutputLength guard must reject the
// bomb as it decodes rather than after materializing multi-GB in memory.
describe("fetchGuarded — decompression bomb cap (#1702)", () => {
  it("rejects a gzip payload whose decompressed size exceeds the cap without materializing it", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    // ~11MB of zeros compresses to a few KB on the wire (sails past the raw-byte
    // cap) but blows the 10MB decompressed cap. WHY this matters: without
    // maxOutputLength, zlib allocates the full 11MB+ before the post-check runs,
    // so a small hostile response can exhaust memory. ResponseTooLargeError
    // proves the guard fired during decode, not after.
    const bomb = gzipSync(Buffer.alloc(11 * 1024 * 1024, 0));
    httpMockRequests.push({
      status: 200,
      headers: { "content-encoding": "gzip", "content-length": String(bomb.length) },
      body: bomb,
    });
    await expect(fetchGuarded("https://feeds.example.com/bomb.gz")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("still decompresses a small legitimate gzip body once the cap is in place", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const plaintext = "small legit payload under the cap";
    httpMockRequests.push({
      status: 200,
      headers: { "content-encoding": "gzip" },
      body: gzipSync(Buffer.from(plaintext, "utf8")),
    });
    const res = await fetchGuarded("https://feeds.example.com/small.gz");
    expect(await res.text()).toBe(plaintext);
  });
});

// #1702 — fetchGuarded forwarded the request body + headers unchanged on every
// redirect hop. Standard fetch security semantics: strip the body/Authorization
// crossing an origin, downgrade to GET on 301/302/303, and only keep method+body
// on a same-origin 307/308.
describe("fetchGuarded — redirect body/header semantics (#1702)", () => {
  function lowerKeys(headers?: Record<string, string>): string[] {
    return Object.keys(headers ?? {}).map((k) => k.toLowerCase());
  }

  it("drops the body and strips Authorization on a cross-origin redirect", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    // 307 normally preserves method+body, so this isolates the cross-origin rule:
    // the method survives but the body + bearer token must not reach a new host.
    httpMockRequests.push({ status: 307, headers: { location: "https://other.example.com/next" } });
    httpMockRequests.push({ status: 200, headers: {}, body: "ok" });
    await fetchGuarded("https://api.example.com/start", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(httpMockCalls).toHaveLength(2);
    const secondHop = httpMockCalls[1]!;
    expect(secondHop.opts.method).toBe("POST"); // 307 keeps the method
    expect(secondHop.endBody).toBeUndefined(); // ...but the body is dropped cross-origin
    const keys = lowerKeys(secondHop.opts.headers);
    expect(keys).not.toContain("authorization"); // credential must not leak
    expect(keys).not.toContain("content-length"); // no stale length without a body
  });

  it("downgrades to GET and drops the body on a 303 (same origin)", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 303, headers: { location: "https://api.example.com/next" } });
    httpMockRequests.push({ status: 200, headers: {}, body: "ok" });
    await fetchGuarded("https://api.example.com/start", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    expect(httpMockCalls).toHaveLength(2);
    const secondHop = httpMockCalls[1]!;
    expect(secondHop.opts.method).toBe("GET");
    expect(secondHop.endBody).toBeUndefined();
  });

  it("preserves method and body on a 307 to the same origin", async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    httpMockRequests.push({ status: 307, headers: { location: "https://api.example.com/next" } });
    httpMockRequests.push({ status: 200, headers: {}, body: "ok" });
    const payload = JSON.stringify({ a: 1 });
    await fetchGuarded("https://api.example.com/start", { method: "POST", body: payload });
    expect(httpMockCalls).toHaveLength(2);
    const secondHop = httpMockCalls[1]!;
    expect(secondHop.opts.method).toBe("POST");
    expect(Buffer.isBuffer(secondHop.endBody)).toBe(true);
    expect((secondHop.endBody as Buffer).toString("utf8")).toBe(payload);
  });
});
