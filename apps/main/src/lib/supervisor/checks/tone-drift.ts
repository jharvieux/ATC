// §10.2 / §24.5 tone_drift check — two sub-checks, both run every response.
//
//   LEXICAL (deterministic):  matches candidate against the union of the
//     platform deny-list (platform_settings.supervisor_slur_deny_list, BP11
//     key — see MEMORY D-046) and the tenant supplemental list
//     (tenant_settings.supplemental_hate_speech_denylist, BP24). A hit
//     returns CRITICAL with the matched term hashed (never the term itself).
//     Run-supervisor enforces the 3-consecutive-hit auto-escalation rule
//     and writes the audit row.
//
//   HEURISTIC (Haiku):  judges the candidate against tenant's tone ceiling,
//     profanity opt-in, mismatched seriousness, and sycophancy. Returns
//     WARNING on severe drift so run-supervisor triggers a regen.
//
// Callers supply the union deny list (loaded once per turn in run-supervisor)
// and optional heuristic context (tenant tone settings + customer prior msg).

import { createHash } from "node:crypto";
import type { CheckInput, SupervisorFinding } from "../types";

export type ToneDriftInput = CheckInput & {
  slurDenyList: string[];
};

// Public so run-supervisor / audit code can compute a stable hash.
export function hashTerm(term: string): string {
  return createHash("sha256").update(term.toLowerCase()).digest("hex").slice(0, 12);
}

function findLexicalMatch(response: string, denyList: string[]): string | null {
  if (denyList.length === 0) return null;
  const lower = response.toLowerCase();
  for (const term of denyList) {
    if (!term || term.length === 0) continue;
    // Word-boundary detection — avoids substring false positives like
    // "scunthorpe". Escape regex metacharacters in the term first.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(lower)) return term;
  }
  return null;
}

type HeuristicVerdict = {
  drift: "none" | "mild" | "severe";
  reasons: string[];
};

async function heuristicTone(input: ToneDriftInput): Promise<HeuristicVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { drift: "none", reasons: ["haiku_unavailable"] };
  if (input.candidate_response.length < 40) {
    return { drift: "none", reasons: ["response_too_short_to_judge"] };
  }

  const model = process.env.CHAT_HAIKU_MODEL ?? "claude-haiku-4-5-20251001";
  const maxLevel = input.tenant_tone_max_level ?? 3;
  const allowProf = input.tenant_allow_profanity ?? false;

  const system = `You judge whether an AI travel assistant's response has drifted in tone or affect.
You return JSON only — no prose.
Output shape: {"drift":"none"|"mild"|"severe","reasons":["..."]}.
Severe drift means the response should be regenerated. Mild drift is acceptable.

Rules (apply to the candidate):
  1. Tone is rated 1 (formal) .. 5 (matched-energy). Tenant ceiling is ${maxLevel}.
     If the candidate clearly reads above the ceiling (slang, jokes when ceiling is 2), drift is severe.
  2. Profanity allowed by tenant: ${allowProf}. If profanity present and not allowed, drift is severe.
  3. Mismatched seriousness: customer expressed frustration / loss / health concern and the
     candidate is light or joking → severe.
  4. Sycophancy: lavish, fake-feeling praise of the customer or their question → mild.
  5. Otherwise: none.`;

  const userBlocks: string[] = [];
  userBlocks.push(`Candidate response (assistant):\n"""${input.candidate_response.slice(0, 4000)}"""`);
  if (input.customer_prior_message) {
    userBlocks.push(`Customer's most recent message:\n"""${input.customer_prior_message.slice(0, 2000)}"""`);
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        system,
        messages: [{ role: "user", content: userBlocks.join("\n\n") }],
      }),
    });
    if (!res.ok) return { drift: "none", reasons: [`haiku_${res.status}`] };
    const body = await res.json() as { content?: Array<{ text?: string }> };
    const raw = body.content?.[0]?.text ?? "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { drift: "none", reasons: ["haiku_unparseable"] };
    const parsed = JSON.parse(match[0]) as { drift?: string; reasons?: string[] };
    const drift: HeuristicVerdict["drift"] =
      parsed.drift === "severe" || parsed.drift === "mild" ? parsed.drift : "none";
    return { drift, reasons: parsed.reasons ?? [] };
  } catch (err) {
    return { drift: "none", reasons: [`haiku_throw: ${String(err)}`] };
  }
}

export async function checkToneDrift(input: ToneDriftInput): Promise<SupervisorFinding> {
  // 1. Lexical sub-check (deterministic, always run, critical on hit).
  const match = findLexicalMatch(input.candidate_response, input.slurDenyList);
  if (match) {
    return {
      check: "tone_drift",
      severity: "critical",
      details: `lexical_match:${hashTerm(match)}`,
    };
  }

  // 2. Heuristic sub-check (Haiku). Warning severity triggers regen.
  const verdict = await heuristicTone(input);
  if (verdict.drift === "severe") {
    return {
      check: "tone_drift",
      severity: "warning",
      details: `heuristic_severe:${verdict.reasons.join(",")}`,
    };
  }
  if (verdict.drift === "mild") {
    return {
      check: "tone_drift",
      severity: "info",
      details: `heuristic_mild:${verdict.reasons.join(",")}`,
    };
  }
  return {
    check: "tone_drift",
    severity: "info",
    details: `pass (lexical clean; heuristic:${verdict.reasons[0] ?? "none"})`,
  };
}
