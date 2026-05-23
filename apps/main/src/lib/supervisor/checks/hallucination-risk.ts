// §21.10 Layer 3 — hallucination_risk check.
//
// Strategy:
//   1. Extract candidate "factual claims" from the response using a Haiku call.
//      Skipped if ANTHROPIC_API_KEY is unset → returns info severity.
//   2. For each claim, look for supporting content in the retrieved chunks
//      by simple keyword overlap (no separate embedding model call — chunks
//      already in context). Threshold: a claim is considered grounded if
//      its key tokens appear in any chunk content above the overlap floor.
//   3. Claims with NO grounding and NOT obviously general knowledge are
//      flagged. We err on the side of grounding: if any single chunk matches
//      enough tokens, the claim passes.
//
// Result severity:
//   - 0 flagged claims → info
//   - 1+ flagged claims → warning (run-supervisor.ts triggers a regen with
//     strict grounding instructions, subject to regen budget per §10.1a)
//
// This check is conservative: false negatives (missed hallucinations) are
// preferable to false positives that thrash the regen budget. The fail-rate
// metric (Task 12) lets operators tune over time.

import type { CheckInput, SupervisorFinding } from "../types";
import { instrumentedClaudeCall } from "@/lib/ai/call-wrapper";

interface RetrievedChunkShape {
  content?: string;
  scoring?: { composite_confidence?: number };
}

const KEYWORD_OVERLAP_FLOOR = 0.5; // ≥50% of claim's content tokens must appear in some chunk

const CLAIM_EXTRACTION_PROMPT = `You read an AI assistant's draft reply and extract any concrete factual claims
that COULD be wrong — prices, dates, ship names, dining venues, cabin counts,
policies, included perks. Skip greetings, opinions, and obvious general knowledge
("cruises typically include meals" is general; "the buffet on Wonder of the Seas
is open until 11pm" is concrete).

Return JSON ONLY:
{ "claims": [ { "text": "...", "claim_type": "price|date|venue|policy|amenity|other" } ] }

If there are no concrete claims, return { "claims": [] }.`;

export async function checkHallucinationRisk(input: CheckInput): Promise<SupervisorFinding> {
  const chunks = (input.retrieved_chunks ?? []) as RetrievedChunkShape[];
  if (chunks.length === 0) {
    return {
      check: "hallucination_risk",
      severity: "info",
      details: "no chunks retrieved — relies on §21.9 no-result instructions",
    };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      check: "hallucination_risk",
      severity: "info",
      details: "skipped (no ANTHROPIC_API_KEY)",
    };
  }

  let claims: Array<{ text: string; claim_type: string }> = [];
  try {
    const model = process.env.ENTITY_EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001";
    const { text } = await instrumentedClaudeCall({
      tenant_id: input.tenant_id ?? "00000000-0000-0000-0000-000000000000",
      conversation_id: input.conversation_id ?? null,
      user_id: input.user_id ?? null,
      model,
      purpose: "chat_supervisor",
      max_tokens: 1024,
      system: CLAIM_EXTRACTION_PROMPT,
      messages: [{ role: "user", content: input.candidate_response }],
    });
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const obj = JSON.parse(cleaned) as { claims?: Array<{ text?: string; claim_type?: string }> };
    claims = (obj.claims ?? [])
      .filter((c): c is { text: string; claim_type: string } => typeof c?.text === "string")
      .map((c) => ({ text: c.text, claim_type: c.claim_type ?? "other" }));
  } catch {
    return {
      check: "hallucination_risk",
      severity: "info",
      details: "claim extraction failed — skipped",
    };
  }

  if (claims.length === 0) {
    return {
      check: "hallucination_risk",
      severity: "info",
      details: "no concrete claims to verify",
    };
  }

  const ungrounded: string[] = [];
  for (const claim of claims) {
    if (!isGroundedByAnyChunk(claim.text, chunks)) {
      ungrounded.push(claim.text);
    }
  }

  if (ungrounded.length === 0) {
    return {
      check: "hallucination_risk",
      severity: "info",
      details: `all ${claims.length} claim(s) grounded in chunks`,
    };
  }

  return {
    check: "hallucination_risk",
    severity: "warning",
    details: `${ungrounded.length} unsupported claim(s): ${ungrounded.slice(0, 3).join(" | ")}`,
  };
}

function isGroundedByAnyChunk(claim: string, chunks: RetrievedChunkShape[]): boolean {
  const claimTokens = tokens(claim);
  if (claimTokens.size === 0) return true;

  for (const c of chunks) {
    if (!c.content) continue;
    const chunkTokens = tokens(c.content);
    let hits = 0;
    for (const t of claimTokens) {
      if (chunkTokens.has(t)) hits++;
    }
    const ratio = hits / claimTokens.size;
    if (ratio >= KEYWORD_OVERLAP_FLOOR) return true;
  }
  return false;
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were",
  "will", "with", "you", "your", "we", "our", "i", "my", "but", "not", "no", "if",
]);

function tokens(s: string): Set<string> {
  const cleaned = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s$]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(cleaned);
}
