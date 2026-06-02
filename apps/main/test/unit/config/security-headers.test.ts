// #557 — every route must carry these security response headers, and the
// X-Powered-By framework-disclosure header must be off. Each assertion encodes a
// specific hardening guarantee (clickjacking, MIME-sniffing, referrer leakage,
// feature lockdown, transport security); the test fails if a header is dropped or
// weakened, or if X-Powered-By is re-enabled. CSP is tracked separately (#572).

import { describe, it, expect } from "vitest";
import nextConfig from "../../../next.config.js";

// next.config.js is JS typed via a NextConfig JSDoc; read its runtime shape
// through a local structural type so these assertions don't ride on Next's
// generic config typings.
type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };
type Cfg = { poweredByHeader?: boolean; headers?: () => Promise<HeaderRule[]> };
const cfg = nextConfig as unknown as Cfg;

async function rules(): Promise<HeaderRule[]> {
  if (!cfg.headers) throw new Error("next.config.js headers() is not defined");
  return cfg.headers();
}

describe("security response headers (#557)", () => {
  it("disables the X-Powered-By framework-disclosure header", () => {
    expect(cfg.poweredByHeader).toBe(false);
  });

  it("applies one catch-all rule covering every route", async () => {
    const r = await rules();
    expect(r).toHaveLength(1);
    expect(r[0]!.source).toBe("/(.*)");
  });

  it("sets each hardening header to its expected value", async () => {
    const r = await rules();
    const value = (key: string) => r[0]!.headers.find((h) => h.key === key)?.value;

    expect(value("X-Frame-Options")).toBe("DENY");
    expect(value("X-Content-Type-Options")).toBe("nosniff");
    expect(value("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(value("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(value("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});
