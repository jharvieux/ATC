// §26.5 — Thin helper for writing audit_log rows.
//
// Constructs its own dedicated service-role client per call so the audit
// row commits independently of any caller's transaction. If the insert
// itself fails, logs to console — never throws (audit writes are forensic;
// losing one isn't worth masking a caller's error).
//
// Callers in route handlers, Inngest jobs, libraries — every prior
// [audit-log:STUB] call site goes through here after BP26.

import "server-only";

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

export interface WriteAuditLogOptions {
  // Some callers (the tenant-suspension crons) need the audit write to
  // fail loud — a thrown error triggers Inngest's automated retry/alerting
  // for security-relevant events where a silently-dropped row is
  // unacceptable. Default (false) preserves the "never masks the caller's
  // own result" behavior every other call site relies on.
  throwOnError?: boolean;
}

export async function writeAuditLog(
  row: AuditRowInput,
  opts?: WriteAuditLogOptions,
): Promise<void> {
  let failure: string | null = null;
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
      failure = error.message;
      console.warn(
        "[audit-log:write-failed] " +
          JSON.stringify({ error: error.message, action: row.action }),
      );
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    console.warn(
      "[audit-log:write-threw] " +
        JSON.stringify({ error: failure, action: row.action }),
    );
  }
  if (failure && opts?.throwOnError) {
    throw new Error(`audit_log insert failed [${row.action}]: ${failure}`);
  }
}
