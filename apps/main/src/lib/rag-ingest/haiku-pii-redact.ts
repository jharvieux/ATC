// §22.4 Stage 2b — Haiku redaction of TOLERABLE PII.
//
// Tolerable categories: names, email addresses, phone numbers.
// Replaces them with [REDACTED] markers. Returns 'clean' if no PII found
// or 'redacted' if at least one replacement was made.
//
// Zero-tolerance PII (SSN, credit card, passport) is detected separately
// by detectZeroTolerancePII in pii-regex-prefilter.ts — those quarantine
// the submission BEFORE this function runs.
//
// On ANY Haiku error or missing ANTHROPIC_API_KEY: returns the input
// content unchanged with status='clean'. The regex-prefilter is the
// safety-critical layer; tolerable-PII redaction is best-effort.

import Anthropic from "@anthropic-ai/sdk";

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

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

export async function haikuPiiRedact(content: string): Promise<HaikuRedactResult> {
  const client = getClient();
  if (!client) return { status: "clean", content };

  const model = process.env.RAG_INGEST_PII_REDACTION_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";

  try {
    const response = await client.messages.create({
      model,
      max_tokens: Math.max(1024, Math.min(content.length * 2, 16000)),
      system: REDACTION_PROMPT,
      messages: [{ role: "user", content }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text.length === 0) {
      return { status: "clean", content };
    }
    const changed = text !== content;
    return changed ? { status: "redacted", content: text } : { status: "clean", content };
  } catch {
    // Best-effort: on any error, treat as clean and proceed.
    return { status: "clean", content };
  }
}
