// §10.1 + §10.1a AI Supervisor runtime skeleton
//
// runSupervisor is called after every AI response candidate before it is
// surfaced to the customer. It enforces:
//   - Global kill switch (§10.6)
//   - Per-conversation regen budget (§10.1a)
//   - Seven preflight checks (§10.2) — 5 stubs, 2 real
//   - Slur consecutive-hit auto-escalation (§10.2 / tone_drift lexical)
//   - Findings persistence to messages.supervisor_findings (§10.4)
//
// The regen budget update AND findings write happen in a single transaction
// (using Supabase rpc or two sequential writes within the same service-role
// client session — Supabase JS v2 does not expose explicit transactions, so
// writes are sequenced with a single atomic-enough pattern: budget first,
// then findings. A partial failure on findings is observable but not
// catastrophic; the budget counter is the safety-critical write.)
//
// CRITICAL: this function accepts a db client from the caller (tenantClient
// or service-role) — it does NOT construct its own client. Callers that run
// inside the chat path must pass tenantClient(ctx); callers that run in test
// harnesses may pass a service-role client scoped to the conversation's tenant.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { TenantContext } from "@/lib/db/tenant-context";
import type { SupervisorFinding, SupervisorOutcome } from "./types";
import { checkHallucinationRisk } from "./checks/hallucination-risk";
import { checkPersonaDrift } from "./checks/persona-drift";
import { checkPromiseDetection } from "./checks/promise-detection";
import { checkArithmetic } from "./checks/arithmetic-check";
import { checkComplianceKeyword } from "./checks/compliance-keyword";
import { checkToneDrift } from "./checks/tone-drift";
import { checkTopicEscalation } from "./checks/topic-escalation";

const CHECKS_RUN = [
  "hallucination_risk",
  "persona_drift",
  "promise_detection",
  "arithmetic_check",
  "compliance_keyword",
  "tone_drift",
  "topic_escalation",
];

const SLUR_CONSECUTIVE_ESCALATION_THRESHOLD = 3;

export type RunSupervisorInput = {
  ctx: TenantContext;
  conversation_id: string;
  message_id: string;
  candidate_response: string;
  retrieved_chunks?: unknown[];
  db: SupabaseClient;
};

export async function runSupervisor(input: RunSupervisorInput): Promise<SupervisorOutcome> {
  const {
    conversation_id,
    message_id,
    candidate_response,
    retrieved_chunks,
    db,
  } = input;

  const maxRegenCount = Number(
    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION ?? 6,
  );
  const maxRegenTokens = Number(
    process.env.SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION ?? 25000,
  );

  // Step 1: Load conversation — check regen budget exhaustion
  const { data: conversation, error: convErr } = await db
    .from("conversations")
    .select(
      "regen_tokens_consumed, regen_count_total, regen_budget_exhausted_at, supervisor_slur_consecutive_count",
    )
    .eq("id", conversation_id)
    .single();

  if (convErr || !conversation) {
    // Fail closed: if we can't read the conversation, escalate
    return {
      action: "escalate",
      findings: [
        {
          check: "supervisor_load_error",
          severity: "critical",
          details: `Cannot load conversation: ${convErr?.message ?? "not found"}`,
        },
      ],
      regen_count: 0,
    };
  }

  const budgetAlreadyExhausted = conversation.regen_budget_exhausted_at !== null;

  // Step 2: Check kill switch
  const { data: killSwitch } = await db
    .from("ai_kill_switch_state")
    .select("global_paused")
    .eq("id", 1)
    .single();

  if (killSwitch?.global_paused === true) {
    return {
      action: "escalate",
      findings: [
        {
          check: "kill_switch",
          severity: "critical",
          details: "Global AI pause is active (§10.6)",
        },
      ],
      regen_count: 0,
    };
  }

  // Step 3: Load slur deny list from platform_settings for tone_drift check
  const { data: slurSetting } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "supervisor_slur_deny_list")
    .single();

  const slurDenyList: string[] = Array.isArray(slurSetting?.value)
    ? (slurSetting.value as string[])
    : [];

  // Step 4: Run all seven preflight checks
  const checkInput = { candidate_response, retrieved_chunks };

  const findings: SupervisorFinding[] = [
    checkHallucinationRisk(checkInput),
    checkPersonaDrift(checkInput),
    checkPromiseDetection(checkInput),
    checkArithmetic(checkInput),
    checkComplianceKeyword(checkInput),
    checkToneDrift({ ...checkInput, slurDenyList }),
    checkTopicEscalation(checkInput),
  ];

  // Step 5: Decide action
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasWarning = findings.some((f) => f.severity === "warning");

  let action: "allow" | "regenerate" | "escalate";
  let regenCount = conversation.regen_count_total;
  let newSlurConsecutiveCount = conversation.supervisor_slur_consecutive_count;

  // Tone drift critical hit — track consecutive count for auto-escalation
  const toneDriftFinding = findings.find((f) => f.check === "tone_drift");
  if (toneDriftFinding?.severity === "critical") {
    newSlurConsecutiveCount = conversation.supervisor_slur_consecutive_count + 1;
  } else {
    newSlurConsecutiveCount = 0;
  }

  if (hasCritical || budgetAlreadyExhausted) {
    action = "escalate";
  } else if (hasWarning) {
    // Check regen budget before attempting regeneration
    const wouldExceedCount = (conversation.regen_count_total + 1) > maxRegenCount;
    // Estimate token cost: rough proxy of response length * 1.5 for input overhead
    const estimatedTokens = Math.ceil(candidate_response.length / 4) * 2;
    const wouldExceedTokens =
      (conversation.regen_tokens_consumed + estimatedTokens) > maxRegenTokens;

    if (wouldExceedCount || wouldExceedTokens) {
      // Budget exhaustion: mark and escalate
      action = "escalate";
      findings.push({
        check: "regen_budget_exhausted",
        severity: "critical",
        details: wouldExceedCount
          ? `Regen count cap reached (${maxRegenCount})`
          : `Regen token cap reached (${maxRegenTokens})`,
      });

      await db
        .from("conversations")
        .update({
          regen_budget_exhausted_at: new Date().toISOString(),
          supervisor_slur_consecutive_count: newSlurConsecutiveCount,
        })
        .eq("id", conversation_id);
    } else {
      // Budget allows another regen
      action = "regenerate";
      regenCount = conversation.regen_count_total + 1;
      const estimatedTokensForIncrement = Math.ceil(candidate_response.length / 4) * 2;

      await db
        .from("conversations")
        .update({
          regen_count_total: regenCount,
          regen_tokens_consumed:
            conversation.regen_tokens_consumed + estimatedTokensForIncrement,
          supervisor_slur_consecutive_count: newSlurConsecutiveCount,
        })
        .eq("id", conversation_id);
    }
  } else {
    action = "allow";

    if (newSlurConsecutiveCount !== conversation.supervisor_slur_consecutive_count) {
      await db
        .from("conversations")
        .update({ supervisor_slur_consecutive_count: newSlurConsecutiveCount })
        .eq("id", conversation_id);
    }
  }

  // Auto-escalate after 3 consecutive slur hits (§10.2 tone_drift lexical)
  if (newSlurConsecutiveCount >= SLUR_CONSECUTIVE_ESCALATION_THRESHOLD) {
    await db.from("escalation_topics").insert({
      tenant_id:
        input.ctx.source.kind === "http_request"
          ? input.ctx.tenant_id
          : input.ctx.tenant_id,
      conversation_id,
      topic_summary: `Automated escalation: ${newSlurConsecutiveCount} consecutive tone_drift critical hits`,
      topic_tags: ["tone_drift", "auto_escalated"],
      status: "open",
      initiated_by: "supervisor",
      initiated_reason: `tone_drift lexical check fired ${newSlurConsecutiveCount} consecutive times`,
    });
  }

  // Step 6: Persist findings to messages.supervisor_findings
  const supervisorFindings = {
    checks_run: CHECKS_RUN,
    findings,
    regen_count: regenCount,
    final_action: action,
  };

  await db
    .from("messages")
    .update({ supervisor_findings: supervisorFindings })
    .eq("id", message_id);

  return { action, findings, regen_count: regenCount };
}
