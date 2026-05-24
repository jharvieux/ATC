// BP39 §33.7.4 — asset_id_validation hallucination defense layer.
//
// One of the §21.10 hallucination defense layers; runs post-generation,
// after content-safety, before final response assembly. Identifies + strips
// any [[display_asset:<id>]] markup the AI emitted with an ID not in the
// per-turn available set.
//
// Result shape is the existing §21.10 LayerResult: severity + counters
// for telemetry. A non-zero `dropped_count` is a `warning` (indicates
// the model is hallucinating; useful signal for prompt tuning) but does
// NOT trigger a regen — the layer is self-healing (strips the markup
// in place).

import { parseDisplayMarkup } from "../parse-display-markup";

export interface LayerResult {
  layer: "asset_id_validation";
  severity: "info" | "warning";
  details: string;
  /** Sanitized output — markup with hallucinated IDs stripped. */
  output: string;
  /** Counters for telemetry. */
  metrics: {
    displayed_count: number;
    dropped_count: number;
    malformed_count: number;
  };
  /** IDs the AI invented but that weren't in the available set. */
  dropped_ids: string[];
  malformed_ids: string[];
}

export function runAssetIdValidationLayer(
  aiOutput: string,
  availableAssetIds: string[],
): LayerResult {
  const parsed = parseDisplayMarkup(aiOutput, availableAssetIds);
  const droppedCount = parsed.droppedIds.length;
  const malformedCount = parsed.malformedIds.length;
  const severity: LayerResult["severity"] = (droppedCount + malformedCount) > 0 ? "warning" : "info";
  const details = severity === "warning"
    ? `stripped ${droppedCount} hallucinated + ${malformedCount} malformed display_asset id(s)`
    : "all display_asset references valid (or none present)";
  return {
    layer: "asset_id_validation",
    severity,
    details,
    output: parsed.sanitizedOutput,
    metrics: {
      displayed_count: parsed.displayedAssetIds.length,
      dropped_count: droppedCount,
      malformed_count: malformedCount,
    },
    dropped_ids: parsed.droppedIds,
    malformed_ids: parsed.malformedIds,
  };
}
