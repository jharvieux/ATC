// §572 — CSP violation collector tests.
//
// parseCspReports: both on-the-wire formats normalize to the same shape, non-CSP
// Reporting-API entries and junk bodies drop out. Route POST: the abuse gates
// (content-type 415, body-size 413) fire, and any well-formed report — including a
// malformed-but-typed body — answers 204 (a telemetry sink never surfaces a client
// error). These encode WHY the endpoint exists: collect violations without trusting,
// blocking, or being floodable by, the unauthenticated caller.

import { describe, it, expect, vi } from "vitest";
import { parseCspReports } from "@/lib/security/csp-report";
import { POST } from "@/app/api/security/csp-report/route";

function post(body: string, contentType: string | null): Request {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  return new Request("http://localhost/api/security/csp-report", {
    method: "POST",
    headers,
    body,
  });
}

describe("parseCspReports — §572", () => {
  it("normalizes a legacy report-uri body (kebab keys, csp-report wrapper)", () => {
    const out = parseCspReports(
      {
        "csp-report": {
          "document-uri": "https://app.example.com/dashboard",
          "violated-directive": "script-src 'self'",
          "blocked-uri": "https://evil.cdn.com/x.js",
          disposition: "report",
        },
      },
      "application/csp-report",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      documentUri: "https://app.example.com/dashboard",
      violatedDirective: "script-src 'self'",
      // effective-directive absent → derived from the first token of violated-directive.
      effectiveDirective: "script-src",
      blockedUri: "https://evil.cdn.com/x.js",
      disposition: "report",
    });
  });

  it("accepts a bare (unwrapped) legacy body posted as application/json", () => {
    const out = parseCspReports(
      { "document-uri": "https://app.example.com/", "violated-directive": "img-src", "blocked-uri": "data:" },
      "application/json",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.effectiveDirective).toBe("img-src");
  });

  it("normalizes a Reporting-API array (camel keys) and filters non-CSP entries", () => {
    const out = parseCspReports(
      [
        {
          type: "csp-violation",
          url: "https://app.example.com/p",
          body: {
            documentURL: "https://app.example.com/p",
            effectiveDirective: "connect-src",
            blockedURL: "https://tracker.io/beacon",
            disposition: "report",
          },
        },
        { type: "deprecation", url: "https://app.example.com/p", body: { id: "x" } },
      ],
      "application/reports+json",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      effectiveDirective: "connect-src",
      blockedUri: "https://tracker.io/beacon",
    });
  });

  it("returns [] for junk bodies and content-less reports", () => {
    expect(parseCspReports("not an object", "application/json")).toEqual([]);
    expect(parseCspReports(null, "application/reports+json")).toEqual([]);
    expect(parseCspReports({ "csp-report": {} }, "application/csp-report")).toEqual([]);
    expect(parseCspReports([{ type: "csp-violation", body: "nope" }], "application/reports+json")).toEqual([]);
  });
});

describe("POST /api/security/csp-report — §572", () => {
  it("rejects an unaccepted content-type with 415", async () => {
    const res = await POST(post("hello", "text/plain"));
    expect(res.status).toBe(415);
  });

  it("rejects a body over the size cap with 413", async () => {
    const huge = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(70 * 1024) } });
    const res = await POST(post(huge, "application/csp-report"));
    expect(res.status).toBe(413);
  });

  it("accepts a valid legacy report with 204", async () => {
    const body = JSON.stringify({
      "csp-report": { "violated-directive": "script-src", "blocked-uri": "https://evil.com/a.js" },
    });
    const res = await POST(post(body, "application/csp-report"));
    expect(res.status).toBe(204);
  });

  it("accepts a valid Reporting-API report with 204", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", body: { effectiveDirective: "frame-src", blockedURL: "https://x.com" } },
    ]);
    const res = await POST(post(body, "application/reports+json"));
    expect(res.status).toBe(204);
  });

  it("swallows a malformed (typed) body with 204 rather than erroring", async () => {
    const res = await POST(post("{not valid json", "application/csp-report"));
    expect(res.status).toBe(204);
  });

  it("logs a parsed violation as structured JSON tagged csp-violation", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({
      "csp-report": { "violated-directive": "object-src", "blocked-uri": "https://uniq-log-test.example/o" },
    });
    await POST(post(body, "application/csp-report"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
      tag: "csp-violation",
      blockedUri: "https://uniq-log-test.example/o",
    });
    spy.mockRestore();
  });
});
