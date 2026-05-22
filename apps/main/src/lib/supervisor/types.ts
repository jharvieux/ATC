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
};
