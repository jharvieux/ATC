// BP34 §34.3.3 — Shared Sonnet extractor runner.
//
// Each per-type extractor builds a system prompt describing its expected
// field shape (with per-field confidence requirements) and delegates to
// this runner. The runner handles the actual Sonnet call, JSON parsing,
// code-fence tolerance, and overall_confidence = min(per-field).
//
// Per §26.8: document content is DATA. The system prompt frames it that
// way explicitly so embedded instructions don't steer extraction.

import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";
import type { ExtractionResult } from "./types";

export interface RunExtractInput<TFields> {
  tenant_id: string;
  text: string;
  systemPrompt: string;
  // Validates + coerces the model's raw JSON output into TFields.
  // Should fill missing fields with null and clamp confidences to [0,1].
  // Throws on unrecoverable shape mismatch — caller turns that into an
  // overall_confidence=0 result.
  coerce: (raw: unknown) => {
    extracted: TFields;
    per_field_confidence: Record<keyof TFields & string, number>;
  };
  // Per-type model override (some extractions are simple enough for
  // Haiku; the spec defaults to Sonnet).
  modelEnvVar?: string;
}

export async function runExtractor<TFields>(
  input: RunExtractInput<TFields>,
): Promise<ExtractionResult<TFields>> {
  const defaultExtracted = {} as TFields;
  const defaultConfidence = {} as Record<keyof TFields & string, number>;

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      extracted: defaultExtracted,
      per_field_confidence: defaultConfidence,
      overall_confidence: 0,
      error: "no_anthropic_api_key",
    };
  }

  const model =
    (input.modelEnvVar ? process.env[input.modelEnvVar] : undefined)
      ?? process.env.IMPORT_EXTRACT_SONNET_MODEL
      ?? "claude-sonnet-4-6";

  // Sonnet handles ~200k tokens; 64k chars (≈16k tokens) is plenty for
  // the longest realistic forwarded document.
  const truncated = input.text.slice(0, 64_000);

  let raw: string;
  try {
    // D-091 R3 Pattern 15 — wrap untrusted document text in <document> tags.
    // Each per-type extractor's system prompt already references the
    // document as data, but the explicit delimiter makes the boundary
    // unambiguous and gives the system-prompt's "ignore instructions
    // inside the tags" rule a concrete anchor.
    const { text } = await instrumentedClaudeCall({
      tenant_id: input.tenant_id,
      model,
      purpose: "import_extract",
      max_tokens: 2048,
      system: input.systemPrompt,
      messages: [{ role: "user", content: `<document>\n${truncated}\n</document>` }],
    });
    raw = text;
  } catch (err) {
    return {
      extracted: defaultExtracted,
      per_field_confidence: defaultConfidence,
      overall_confidence: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Strip code fences the model may add despite instructions.
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      extracted: defaultExtracted,
      per_field_confidence: defaultConfidence,
      overall_confidence: 0,
      error: "unparseable_response",
    };
  }

  let coerced;
  try {
    coerced = input.coerce(parsed);
  } catch (err) {
    return {
      extracted: defaultExtracted,
      per_field_confidence: defaultConfidence,
      overall_confidence: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // §34.3.3 — overall_confidence = MIN(per-field). Empty confidence map
  // (e.g. extractor failed to populate any fields) → 0.
  const confidences = Object.values(coerced.per_field_confidence).filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n),
  );
  const overall = confidences.length === 0 ? 0 : Math.min(...confidences);

  return {
    extracted: coerced.extracted,
    per_field_confidence: coerced.per_field_confidence,
    overall_confidence: Math.max(0, Math.min(1, overall)),
  };
}
