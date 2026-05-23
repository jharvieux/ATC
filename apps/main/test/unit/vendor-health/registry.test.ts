// §26.9 — Vendor health registry state transitions.

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordVendorFailure,
  recordVendorSuccess,
  vendorHealthStatus,
  _resetVendorHealthForTests,
} from "@/lib/vendor-health/registry";

describe("vendorHealthStatus", () => {
  beforeEach(() => _resetVendorHealthForTests());

  it("starts healthy", () => {
    expect(vendorHealthStatus("anthropic")).toBe("healthy");
  });

  it("degrades after 3 consecutive failures", () => {
    recordVendorFailure("anthropic", "timeout");
    recordVendorFailure("anthropic", "timeout");
    expect(vendorHealthStatus("anthropic")).toBe("healthy");
    recordVendorFailure("anthropic", "timeout");
    expect(vendorHealthStatus("anthropic")).toBe("degraded");
  });

  it("escalates to down after 5 consecutive failures", () => {
    for (let i = 0; i < 5; i++) recordVendorFailure("anthropic", "5xx");
    expect(vendorHealthStatus("anthropic")).toBe("down");
  });

  it("returns to healthy on any success", () => {
    for (let i = 0; i < 6; i++) recordVendorFailure("openai", "x");
    expect(vendorHealthStatus("openai")).toBe("down");
    recordVendorSuccess("openai");
    expect(vendorHealthStatus("openai")).toBe("healthy");
  });

  it("tracks per-vendor independently", () => {
    for (let i = 0; i < 5; i++) recordVendorFailure("stripe", "x");
    expect(vendorHealthStatus("stripe")).toBe("down");
    expect(vendorHealthStatus("resend")).toBe("healthy");
  });
});
