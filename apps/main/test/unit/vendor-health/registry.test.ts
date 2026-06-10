// §26.9 — Vendor health registry state transitions.

import { describe, it, expect, beforeEach } from "vitest";
import {
  recordVendorFailure,
  recordVendorSuccess,
  vendorHealthStatus,
  snapshotVendorHealth,
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

  it("#785: new vendors start healthy — inngest, upstash, rag, supabase_rag", () => {
    expect(vendorHealthStatus("inngest")).toBe("healthy");
    expect(vendorHealthStatus("upstash")).toBe("healthy");
    expect(vendorHealthStatus("rag")).toBe("healthy");
    expect(vendorHealthStatus("supabase_rag")).toBe("healthy");
  });

  it("#785: new vendors appear in snapshotVendorHealth()", () => {
    const snap = snapshotVendorHealth();
    expect(Object.keys(snap)).toEqual(
      expect.arrayContaining(["inngest", "upstash", "rag", "supabase_rag"]),
    );
  });
});
