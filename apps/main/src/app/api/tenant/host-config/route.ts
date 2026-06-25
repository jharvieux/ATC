// §13.4 / §13.7 — GET + POST /api/tenant/host-config
//
// GET: lists available adapters with their current config state for this tenant.
// POST: saves encrypted host adapter credentials.
//   Credentials are encrypted via encryptCredential() before DB write.
//   After save, invokes the adapter's healthCheck() to set credential_status.

import { z } from "zod";
import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { encryptCredential } from "@/lib/crypto/credential-cipher";
import { getAdapter, listActiveAdapters } from "@/lib/host-adapters/registry";
import { safeAwait } from "@/lib/db/safe-mutation";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "host_config", action: "read" });
    const allAdapters = await listActiveAdapters();
    const db = tenantClient(ctx);

    const { data: configs } = await db
      .from("tenant_host_configs")
      .select("adapter_id, credential_status")
      .eq("is_active", true);

    const statusByAdapter = new Map<string, string>(
      ((configs as { adapter_id: string; credential_status: string }[] | null) ?? []).map(
        (r) => [r.adapter_id, r.credential_status],
      ),
    );

    const adapters = allAdapters.map((a) => ({
      adapter_id: a.adapter_id,
      display_name: a.display_name,
      capabilities: a.capabilities,
      current_status: statusByAdapter.get(a.adapter_id) ?? "not_configured",
    }));

    return Response.json({ adapters });
  } catch (err) {
    return respondToAuthError(err);
  }
}

const BodySchema = z.object({
  adapter_id: z.string().min(1),
  credentials_json: z.record(z.unknown()),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "host_config", action: "write" });

    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { adapter_id, credentials_json } = parsed.data;
    const plaintext = JSON.stringify(credentials_json);
    const encrypted = encryptCredential(plaintext);

    const db = tenantClient(ctx);
    const { data: existing } = await db
      .from("tenant_host_configs")
      .select("id")
      .eq("adapter_id", adapter_id)
      .maybeSingle();

    let upsertError: { message: string } | null = null;

    if (existing) {
      const { error } = await db
        .from("tenant_host_configs")
        .update({
          credentials: encrypted,
          credential_status: "pending",
          credential_verified_at: null,
          is_active: true,
        })
        .eq("adapter_id", adapter_id);
      upsertError = error;
    } else {
      const { error } = await db.from("tenant_host_configs").insert({
        tenant_id: ctx.tenant_id,
        adapter_id,
        credentials: encrypted,
        credential_status: "pending",
        is_active: true,
      });
      upsertError = error;
    }

    if (upsertError) return dbErrorResponse(upsertError);

    // Verify credentials by invoking the adapter's healthCheck
    let newStatus: "verified" | "rejected" = "rejected";
    try {
      const adapter = await getAdapter(adapter_id);
      const health = await adapter.healthCheck();
      newStatus = health.ok ? "verified" : "rejected";
    } catch (err) {
      console.error("[host-config] adapter healthCheck failed", { adapter_id, error: String(err) });
      newStatus = "rejected";
    }

    await safeAwait(db
      .from("tenant_host_configs")
      .update({
        credential_status: newStatus,
        credential_verified_at: newStatus === "verified" ? new Date().toISOString() : null,
      })
      .eq("adapter_id", adapter_id), "tenant_host_configs.update");

    return Response.json({ ok: true, credential_status: newStatus });
  } catch (err) {
    return respondToAuthError(err);
  }
}
