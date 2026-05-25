// BP34 §34.3.5 — routing decision tests.

import { describe, expect, it } from "vitest";
import { decideRoute } from "@/lib/import/auto-accept";

function fakeDb(args: {
  tenantThreshold?: number | null;
  platformDefault?: number | null;
}) {
  return {
    from: (table: string) => {
      if (table === "tenant_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    args.tenantThreshold !== undefined
                      ? { import_auto_accept_threshold: args.tenantThreshold }
                      : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data:
                    args.platformDefault !== undefined
                      ? { value: args.platformDefault }
                      : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("decideRoute", () => {
  it("auto-accepts when confidence ≥ threshold and no flags", async () => {
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "booking_confirmation",
      overall_confidence: 0.95,
      validation_flags: [],
      db: fakeDb({ platformDefault: 0.8 }),
    });
    expect(decision.route).toBe("auto_accept");
    expect(decision.threshold_used).toBe(0.8);
  });

  it("routes to review when confidence below threshold", async () => {
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "booking_confirmation",
      overall_confidence: 0.72,
      validation_flags: [],
      db: fakeDb({ platformDefault: 0.8 }),
    });
    expect(decision.route).toBe("review");
    expect(decision.reason).toContain("below threshold");
  });

  it("routes to review when any validation flag exists", async () => {
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "booking_confirmation",
      overall_confidence: 0.99,
      validation_flags: [{ flag: "missing_required", reason: "x" }],
      db: fakeDb({ platformDefault: 0.8 }),
    });
    expect(decision.route).toBe("review");
    expect(decision.reason).toContain("missing_required");
  });

  it("never auto-accepts commission_statement", async () => {
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "commission_statement",
      overall_confidence: 1.0,
      validation_flags: [],
      db: fakeDb({ platformDefault: 0.8 }),
    });
    expect(decision.route).toBe("review");
    expect(decision.reason).toContain("never auto-accepts");
  });

  it("respects per-tenant threshold override", async () => {
    // Tenant raised threshold to 0.95 — 0.85 confidence no longer enough.
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "booking_confirmation",
      overall_confidence: 0.85,
      validation_flags: [],
      db: fakeDb({ tenantThreshold: 0.95, platformDefault: 0.8 }),
    });
    expect(decision.route).toBe("review");
    expect(decision.threshold_used).toBe(0.95);
  });

  it("falls back to 0.8 if platform_settings missing", async () => {
    const decision = await decideRoute({
      tenant_id: "t1",
      document_type: "booking_confirmation",
      overall_confidence: 0.79,
      validation_flags: [],
      db: fakeDb({}),
    });
    expect(decision.route).toBe("review");
    expect(decision.threshold_used).toBe(0.8);
  });
});
