// §22.4 Stage 2 — Tolerable-PII redaction via Haiku.
//
// On ANY Haiku error or missing ANTHROPIC_API_KEY: returns the input
// content unchanged with status='clean'. The regex-prefilter is the
// safety-critical layer; tolerable-PII redaction is best-effort.

import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";

export type HaikuRedactResult =
  | { status: "clean"; content: string }
  | { status: "redacted"; content: string };

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
  if (!process.env.ANTHROPIC_API_KEY) return { status: "clean", content };
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
    if (text.length === 0) return { status: "clean", content };
    return text !== content
      ? { status: "redacted", content: text }
      : { status: "clean", content };
  } catch {
    return { status: "clean", content };
  }
}
