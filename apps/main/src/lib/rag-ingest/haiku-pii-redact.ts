// §22.4 Stage 2 — Tolerable-PII redaction via Haiku.
//
// FAIL-CLOSED contract (D-091 Round-3 #44 fix):
//   - Missing ANTHROPIC_API_KEY → status='failed' (caller must quarantine).
//   - Haiku call throws → status='failed' (caller must quarantine).
//   - Haiku returns empty text → status='failed' (model output unusable).
//
// Pre-fix this returned status='clean' on each of those branches, which
// downstream callers interpreted as "no tolerable PII detected, safe to
// promote." Under a missing-key incident every submission would have
// silently bypassed Haiku redaction — names/emails/phones surfaced to
// the knowledge base unredacted.
//
// The regex prefilter still catches zero-tolerance categories (SSN /
// credit card / passport) upstream of this function — that remains the
// safety-critical layer. This module's `failed` status means
// "tolerable-PII layer did not run; caller decides what to do."

import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";

export type HaikuRedactResult =
  | { status: "clean"; content: string }
  | { status: "redacted"; content: string }
  | { status: "failed"; reason: string };

const REDACTION_PROMPT = `You are a PII redaction filter. The user provides text from a travel
agency's knowledge base. Replace the following with [REDACTED]:
  - Personal names of customers (not company names, ship names, persona
    names, port names, or destinations)
  - Email addresses
  - Phone numbers (any format)

Preserve EVERYTHING ELSE exactly — formatting, line breaks, all other words,
URLs, prices, dates, ship names, port names. Do not summarize or rephrase.

Output ONLY the redacted text. No explanation, no JSON, no code fences.`;

export async function haikuPiiRedact(
  content: string,
  ctx: { tenant_id: string } = { tenant_id: "00000000-0000-0000-0000-000000000000" },
): Promise<HaikuRedactResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { status: "failed", reason: "anthropic_api_key_missing" };
  }
  const model = process.env.RAG_INGEST_PII_REDACTION_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

  try {
    const { text } = await instrumentedClaudeCall({
      tenant_id: ctx.tenant_id,
      model,
      purpose: "rag_pii_redaction",
      max_tokens: Math.max(1024, Math.min(content.length * 2, 16000)),
      system: REDACTION_PROMPT,
      messages: [{ role: "user", content }],
    });
    if (text.length === 0) {
      return { status: "failed", reason: "haiku_empty_response" };
    }
    return text !== content
      ? { status: "redacted", content: text }
      : { status: "clean", content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: `haiku_error: ${msg}` };
  }
}
