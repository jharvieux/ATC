// §21.10 — Defense-layer metrics.
//
// Emit a structured line per defense outcome. Until the audit_log table lands
// (§26), entries go to console.warn with category 'metric.rag_defense'. A
// future pass replaces this with an audit_log INSERT — the JSON shape below
// is the schema-stable record.
//
// Metrics tracked:
//   - hallucination_risk fire rate (warning hits / total runs)
//   - block-after-regen rate (escalations following a regen warning)
//   - escalation rate due to confidence floor (no-result or low-confidence
//     escalation_safety_net hits)
//   - thumbs-down per persona per topic — emitted by BP09's feedback endpoint
//   - per-chunk role in flagged responses — emitted by BP09's authority loop
//   - compound metric: thumbs-down × confidence — derived in aggregation
//
// Callers emit one record per supervisor run; aggregation is downstream.

import type { SupervisorOutcome } from "./types";

export interface DefenseMetricRecord {
  category: "metric.rag_defense";
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  persona_slug: string | null;
  intent: string | null;
  final_action: SupervisorOutcome["action"];
  regen_count: number;
  hits: Record<string, "info" | "warning" | "critical">;
  retrieved_chunks_used: number;
  max_chunk_confidence: number;
  ts: string;
}

export function emitDefenseMetric(rec: Omit<DefenseMetricRecord, "category" | "ts">): void {
  const out: DefenseMetricRecord = {
    ...rec,
    category: "metric.rag_defense",
    ts: new Date().toISOString(),
  };
  // TODO(audit-log §26): swap to public.audit_log INSERT with action='metric.rag_defense'.
  console.warn("[metric.rag_defense] " + JSON.stringify(out));
}
