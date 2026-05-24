// BP39 §33.7.4 — asset_id_validation hallucination defense layer test.

import { describe, expect, it } from "vitest";
import { runAssetIdValidationLayer } from "../../../src/lib/ai/hallucination-defense/asset-id-validation";

const A = "11111111-1111-4111-8111-111111111111";
const HALLUCINATED = "99999999-9999-4999-8999-999999999999";

describe("runAssetIdValidationLayer", () => {
  it("returns info severity when no display markup is present", () => {
    const r = runAssetIdValidationLayer("Plain reply with no images.", [A]);
    expect(r.severity).toBe("info");
    expect(r.metrics.dropped_count).toBe(0);
    expect(r.output).toBe("Plain reply with no images.");
  });

  it("returns info severity when all IDs are valid", () => {
    const r = runAssetIdValidationLayer(`Deck 9: [[display_asset:${A}]]`, [A]);
    expect(r.severity).toBe("info");
    expect(r.metrics.displayed_count).toBe(1);
    expect(r.metrics.dropped_count).toBe(0);
  });

  it("returns warning severity when a hallucinated ID is stripped", () => {
    const r = runAssetIdValidationLayer(`See: [[display_asset:${HALLUCINATED}]]`, [A]);
    expect(r.severity).toBe("warning");
    expect(r.metrics.dropped_count).toBe(1);
    expect(r.dropped_ids).toContain(HALLUCINATED);
    expect(r.output).not.toContain("display_asset");
  });

  it("returns warning when malformed markup is stripped", () => {
    const r = runAssetIdValidationLayer("See: [[display_asset:abc]]", [A]);
    expect(r.severity).toBe("warning");
    expect(r.metrics.malformed_count).toBe(1);
    expect(r.malformed_ids).toContain("abc");
  });

  it("output is self-healing (no regen needed) — caller uses .output directly", () => {
    const before = `Deck 9: [[display_asset:${A}]]. Spurious: [[display_asset:${HALLUCINATED}]].`;
    const r = runAssetIdValidationLayer(before, [A]);
    expect(r.output).toContain(A);
    expect(r.output).not.toContain(HALLUCINATED);
  });
});
