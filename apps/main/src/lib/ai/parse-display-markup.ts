// BP39 §33.7.3 / §33.7.4 — display markup parser + hallucination defense.
//
// AI emits inline markup `[[display_asset:<uuid>]]`. This parser:
//   1. Finds all matches.
//   2. Validates each UUID against the per-turn `availableAssetIds`.
//   3. Strips hallucinated IDs (not in the set) — security-critical:
//      a hallucinated ID could point at any UUID-shaped string, including
//      another tenant's asset by collision (vanishingly unlikely but
//      defense-in-depth).
//   4. Preserves valid markup verbatim — the consumer client renders it.
//
// Returns the sanitized output + which IDs were displayed + which were
// dropped (the latter goes to telemetry for prompt-tuning).

const MARKUP_RE = /\[\[display_asset:([^\]]{1,80})\]\]/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ParseResult {
  /** Output with hallucinated markup stripped; valid markup left in place. */
  sanitizedOutput: string;
  /** IDs the AI emitted AND that were in the available set, in order of first occurrence. */
  displayedAssetIds: string[];
  /** IDs the AI emitted that were NOT in the available set (hallucination). */
  droppedIds: string[];
  /** Strings the parser matched that weren't UUIDs at all (malformed markup). */
  malformedIds: string[];
}

export function parseDisplayMarkup(aiOutput: string, availableAssetIds: string[]): ParseResult {
  const allowed = new Set(availableAssetIds);
  const displayed = new Set<string>();
  const displayedOrder: string[] = [];
  const dropped: string[] = [];
  const malformed: string[] = [];

  const sanitized = aiOutput.replace(MARKUP_RE, (full, rawId: string) => {
    const id = rawId.toLowerCase();
    if (!UUID_RE.test(id)) {
      malformed.push(rawId);
      return ""; // strip malformed markup
    }
    if (!allowed.has(id)) {
      dropped.push(id);
      return ""; // strip hallucinated markup
    }
    if (!displayed.has(id)) {
      displayed.add(id);
      displayedOrder.push(id);
    }
    return full; // keep valid markup verbatim — client renders it
  });

  return {
    sanitizedOutput: sanitized,
    displayedAssetIds: displayedOrder,
    droppedIds: dropped,
    malformedIds: malformed,
  };
}
