// §10.4 Supervisor Findings (per message)
//
// Every preflight check produces a finding. The full set is persisted to
// messages.supervisor_findings as JSONB at the end of each supervisor run.

export type SupervisorFindingSeverity = "info" | "warning" | "critical";

export type SupervisorFinding = {
  check: string;
  severity: SupervisorFindingSeverity;
  details: string;
};

export type SupervisorFindings = {
  checks_run: string[];
  findings: SupervisorFinding[];
  regen_count: number;
  final_action: "allow" | "regenerate" | "escalate";
};

export type SupervisorOutcome = {
  action: "allow" | "regenerate" | "escalate";
  findings: SupervisorFinding[];
  regen_count: number;
};

export type CheckInput = {
  candidate_response: string;
  retrieved_chunks?: unknown[] | undefined;
  // §21.10 extras — populated by the chat handler when available.
  // Checks that don't need these fields simply ignore them.
  entities?: {
    intent?: "research" | "compare" | "book" | "support" | string;
    categories_hint?: string[];
  } | undefined;
  // True if the persona has offered human escalation in the last N turns
  // (§21.10 layer 8: suppress repeated escalation prompts).
  recent_escalation_offered?: boolean | undefined;
  // True if the persona system prompt instructed the model to specialize on
  // medical / accessibility / dietary topics (rare; usually false).
  persona_specializes_in_sensitive?: boolean | undefined;
  // §21.10 persona-drift: optional reference text used by checkPersonaDrift.
  persona_base_summary?: string | undefined;
  // §24.5 tone_drift heuristic context. Populated by the chat handler from
  // tenant_settings + the customer's prior message.
  tenant_tone_max_level?: number | undefined;
  tenant_allow_profanity?: boolean | undefined;
  customer_prior_message?: string | undefined;
};

export type AsyncCheck = (input: CheckInput) => Promise<SupervisorFinding>;
export type SyncCheck = (input: CheckInput) => SupervisorFinding;
