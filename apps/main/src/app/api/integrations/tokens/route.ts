// #712 — Personal access token management.
//
// GET  /api/integrations/tokens — list caller's tokens (no hashes returned)
// POST /api/integrations/tokens — create a new token (plaintext returned once)
//
// Tokens are owner-only. Agents and viewers cannot mint or list tokens.
// All DB access is via service_role — personal_access_tokens has no
// authenticated PostgREST policies (rls-exceptions.sql).

import { createHash, randomBytes } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

const VALID_SCOPES = new Set([
  "rag_submissions:create",
]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "api_tokens", action: "list" });

    const svc = createServiceRoleClient();
    const { data, error } = await svc
      .from("personal_access_tokens")
      .select("id, name, scopes, created_at, last_used_at, revoked_at")
      .eq("tenant_id", ctx.tenant_id)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ tokens: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "api_tokens", action: "create" });

    const body = (await req.json()) as { name?: unknown; scopes?: unknown };

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    const name = body.name.trim();
    if (name.length > 100) {
      return Response.json({ error: "name must be 100 characters or fewer" }, { status: 400 });
    }

    const scopes: string[] = Array.isArray(body.scopes) ? body.scopes : ["rag_submissions:create"];
    for (const s of scopes) {
      if (typeof s !== "string" || !VALID_SCOPES.has(s)) {
        return Response.json({ error: `Invalid scope: ${s}` }, { status: 400 });
      }
    }

    const rawToken = `atc_pat_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const svc = createServiceRoleClient();
    const { data, error } = await svc
      .from("personal_access_tokens")
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: user.id,
        created_by_user_id: user.id,
        name,
        token_hash: tokenHash,
        scopes,
      })
      .select("id, name, scopes, created_at")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 500 });

    // Return the plaintext token once — it is never readable again.
    return Response.json({ token: rawToken, ...data }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
