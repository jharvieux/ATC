// §21.10 — Defense-layer metrics.
//
// Emit one audit_log row per defense outcome with action='metric.rag_defense'.
// Aggregation (rates / per-tenant rollups) happens downstream against
// audit_log.
//
// Metrics tracked:
//   - hallucination_risk fire rate (warning hits / total runs)
//   - block-after-regen rate (escalations following a regen warning)
//   - escalation rate due to confidence floor (no-result or low-confidence
//     escalation_safety_net hits)
//   - thumbs-down per persona per topic — emitted by BP09's feedback endpoint
//   - per-chunk role in flagged responses — emitted by BP09's authority loop
//   - compound metric: thumbs-down × confidence — derived in aggregation

import type { SupervisorOutcome } from "./types";
import { writeAuditLog } from "@/lib/audit/write";

export interface DefenseMetricRecord {
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
}

export function emitDefenseMetric(rec: DefenseMetricRecord): void {
  void writeAuditLog({
    tenant_id: rec.tenant_id,
    actor_type: "system",
    action: "metric.rag_defense",
    resource_type: "message",
    resource_id: rec.message_id,
    changes: {
      conversation_id: rec.conversation_id,
      persona_slug: rec.persona_slug,
      intent: rec.intent,
      final_action: rec.final_action,
      regen_count: rec.regen_count,
      hits: rec.hits,
      retrieved_chunks_used: rec.retrieved_chunks_used,
      max_chunk_confidence: rec.max_chunk_confidence,
    },
  });
}
