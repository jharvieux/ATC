// §10.5a Supervisor Sampling and Review Queue
//
// Called after every supervisor run that reaches a final decision.
// Determines whether to snapshot the message into supervisor_review_queue
// based on the outcome category and configured sample rates.
//
// Sampling is at supervisor-completion time (atomic snapshot) to prevent
// "data I wanted to review changed before I got to it."
//
// Escalations are always inserted (100% rate — every escalation is reviewable).
// Other categories are sampled probabilistically against platform_settings rates.
//
// N=5 recent messages captured as conversation context snapshot per §10.5a default.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SupervisorFinding } from "./types";

const CONTEXT_MESSAGE_WINDOW = 5;

export type SampleForReviewInput = {
  message_id: string;
  conversation_id: string;
  tenant_id: string;
  action: "allow" | "regenerate" | "escalate";
  findings: SupervisorFinding[];
  db: SupabaseClient;
};

type SampleCategory = "clean_pass" | "warning_pass" | "regen_attempted" | "escalation";

function determineSampleCategory(
  action: "allow" | "regenerate" | "escalate",
  findings: SupervisorFinding[],
): SampleCategory {
  if (action === "escalate") return "escalation";
  if (action === "regenerate") return "regen_attempted";
  const hasWarning = findings.some((f) => f.severity === "warning");
  return hasWarning ? "warning_pass" : "clean_pass";
}

const RATE_SETTING_KEYS: Record<SampleCategory, string> = {
  clean_pass: "supervisor_sample_rate_clean_pass",
  warning_pass: "supervisor_sample_rate_warning_pass",
  regen_attempted: "supervisor_sample_rate_regen",
  escalation: "supervisor_sample_rate_regen", // escalation always inserts; key unused
};

const DEFAULT_RATES: Record<SampleCategory, number> = {
  clean_pass: 0.01,
  warning_pass: 0.10,
  regen_attempted: 0.25,
  escalation: 1.0,
};

export async function maybeSampleForReview(input: SampleForReviewInput): Promise<void> {
  const { message_id, conversation_id, tenant_id, action, findings, db } = input;

  const category = determineSampleCategory(action, findings);

  // Read configured sample rates from platform_settings
  const settingKey = RATE_SETTING_KEYS[category];
  const { data: rateSetting } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", settingKey)
    .single();

  const rate =
    category === "escalation"
      ? 1.0
      : typeof rateSetting?.value === "number"
        ? rateSetting.value
        : DEFAULT_RATES[category];

  // Probabilistic sample (escalation always inserts)
  if (category !== "escalation" && Math.random() > rate) {
    return;
  }

  // Read retention setting
  const { data: retentionSetting } = await db
    .from("platform_settings")
    .select("value")
    .eq("key", "supervisor_review_retention_days")
    .single();

  const retentionDays =
    typeof retentionSetting?.value === "number" ? retentionSetting.value : 90;

  // Fetch last N messages for context snapshot
  const { data: recentMessages } = await db
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversation_id)
    .order("created_at", { ascending: false })
    .limit(CONTEXT_MESSAGE_WINDOW);

  const purgeAfter = new Date(
    Date.now() + retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  await db.from("supervisor_review_queue").insert({
    tenant_id,
    message_id,
    conversation_id,
    sample_category: category,
    supervisor_findings_snapshot: { findings, final_action: action },
    conversation_context_snapshot: { messages: recentMessages ?? [] },
    purge_after: purgeAfter,
  });
}
