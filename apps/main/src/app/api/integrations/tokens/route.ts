// #712 / #996 — Personal access token management.
//
// GET  /api/integrations/tokens — list tokens
//   tenant_owner: all tokens in tenant with acting-user display name
//   other roles: only tokens where user_id = caller (self-view)
// POST /api/integrations/tokens — create a new token (plaintext returned once)
//   tenant_owner only; optional user_id mints a token acting as any active
//   tenant member (defaults to caller)
//
// All DB access is via service_role — personal_access_tokens has no
// authenticated PostgREST policies (rls-exceptions.sql).

import { createHash, randomBytes } from "node:crypto";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { respondToAuthError } from "@/lib/auth/respond";

const VALID_SCOPES = new Set(["rag_submissions:create"]);

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "api_tokens", action: "list" });

    const svc = createServiceRoleClient();
    const isOwner = user.role === "tenant_owner";

    let query = svc
      .from("personal_access_tokens")
      .select(
        "id, name, scopes, created_at, last_used_at, revoked_at, user_id, created_by_user_id, users!personal_access_tokens_user_id_fkey(display_name, email), creators:users!personal_access_tokens_created_by_user_id_fkey(display_name, email)",
      )
      .eq("tenant_id", ctx.tenant_id);

    if (!isOwner) {
      // Non-owners see only tokens that act as them. Without this filter a
      // viewer could read tokens minted for other members.
      query = query.eq("user_id", user.id);
    }

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
    return Response.json({ tokens: data ?? [], is_owner: isOwner });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "api_tokens", action: "create" });

    const body = (await req.json()) as { name?: unknown; scopes?: unknown; user_id?: unknown };

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

    // Resolve the acting user. Defaults to caller; owner may specify another
    // active member of the same tenant.
    let actingUserId = user.id;
    if (body.user_id !== undefined) {
      if (typeof body.user_id !== "string" || body.user_id.trim().length === 0) {
        return Response.json({ error: "user_id must be a non-empty string" }, { status: 400 });
      }
      if (body.user_id !== user.id) {
        // Verify the target is an active member of this tenant (second-layer tenant isolation).
        const svc = createServiceRoleClient();
        const { data: member, error: lookupErr } = await svc
          .from("users")
          .select("id, status")
          .eq("id", body.user_id)
          .eq("tenant_id", ctx.tenant_id)
          .eq("status", "active")
          .maybeSingle();

        if (lookupErr) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });
        if (!member) {
          return Response.json(
            { error: "user_id is not an active member of this tenant" },
            { status: 422 },
          );
        }
      }
      actingUserId = body.user_id;
    }

    const rawToken = `atc_pat_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    const svc = createServiceRoleClient();
    const { data, error } = await svc
      .from("personal_access_tokens")
      .insert({
        tenant_id: ctx.tenant_id,
        user_id: actingUserId,
        created_by_user_id: user.id,
        name,
        token_hash: tokenHash,
        scopes,
      })
      .select("id, name, scopes, created_at")
      .single();

    if (error) return Response.json({ error: "db_error", ref: crypto.randomUUID() }, { status: 500 });

    // Return the plaintext token once — it is never readable again.
    return Response.json({ token: rawToken, ...data }, { status: 201 });
  } catch (err) {
    return respondToAuthError(err);
  }
}
