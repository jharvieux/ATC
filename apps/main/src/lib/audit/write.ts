// §26.5 — Thin helper for writing audit_log rows.
//
// Constructs its own dedicated service-role client per call so the audit
// row commits independently of any caller's transaction. If the insert
// itself fails, logs to console — never throws (audit writes are forensic;
// losing one isn't worth masking a caller's error).
//
// Callers in route handlers, Inngest jobs, libraries — every prior
// [audit-log:STUB] call site goes through here after BP26.

import { createServiceRoleClient } from "@/lib/db/service-role-client";

export type AuditActorType = "user" | "system" | "admin" | "ai";

export interface AuditRowInput {
  tenant_id?: string | null;
  actor_user_id?: string | null;
  actor_type: AuditActorType;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  changes?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
}

export async function writeAuditLog(row: AuditRowInput): Promise<void> {
  try {
    const db = createServiceRoleClient();
    const { error } = await db.from("audit_log").insert({
      tenant_id: row.tenant_id ?? null,
      actor_user_id: row.actor_user_id ?? null,
      actor_type: row.actor_type,
      action: row.action,
      resource_type: row.resource_type,
      resource_id: row.resource_id ?? null,
      changes: row.changes ?? null,
      context: row.context ?? null,
    });
    if (error) {
      console.warn(
        "[audit-log:write-failed] " +
          JSON.stringify({ error: error.message, action: row.action }),
      );
    }
  } catch (err) {
    console.warn(
      "[audit-log:write-threw] " +
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
          action: row.action,
        }),
    );
  }
}
