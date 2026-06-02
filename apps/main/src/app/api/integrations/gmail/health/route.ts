// BP34 §34.2.4 — Gmail integration health endpoint.
//
// Returns the current health state for the calling tenant's Gmail
// connection so the CRM can render the §34.2.4 status pill + persistent
// banner. The banner is required v1 — without it, agents can send
// IMPORT emails for weeks expecting parsing while none is occurring.
//
// Shape:
//   { health_status: 'connected' | 'token_expired' | 'revoked' | 'disconnected',
//     connected_email: string | null,
//     last_healthy_at: string | null,
//     last_health_error: string | null,
//     pubsub_watch_expires_at: string | null }

import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, {
      resource: "integrations.gmail",
      action: "read",
    });

    const svc = createServiceRoleClient();
    const { data, error } = await svc
      .from("gmail_oauth_tokens")
      .select("health_status, connected_email, last_healthy_at, last_health_error, pubsub_watch_expires_at")
      .eq("tenant_id", ctx.tenant_id)
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // No row → never connected.
    if (!data) {
      return Response.json({
        health_status: "disconnected",
        connected_email: null,
        last_healthy_at: null,
        last_health_error: null,
        pubsub_watch_expires_at: null,
      });
    }

    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}
