// #963 — Tenant email template overrides: list endpoint.
// GET: registry (types, variable docs, default subjects) merged with the
// tenant's current overrides — everything the settings page needs.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { EMAIL_TEMPLATE_REGISTRY, EMAIL_TEMPLATE_TYPES } from "@/lib/email/template-registry";

interface OverrideRow {
  email_type: string;
  subject_template: string | null;
  body_template: string | null;
  updated_at: string;
}

export async function GET(req: Request): Promise<Response> {
  let auth;
  try {
    auth = await assertPermission(req, { resource: "email_templates", action: "read" });
  } catch (err) {
    return respondToAuthError(err);
  }
  const { ctx } = auth;

  const db = tenantClient(ctx);
  const { data, error } = await db
    .from("tenant_email_templates")
    .select("email_type, subject_template, body_template, updated_at");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const overrides = new Map(((data ?? []) as OverrideRow[]).map((r) => [r.email_type, r]));

  const templates = EMAIL_TEMPLATE_TYPES.map((type) => {
    const spec = EMAIL_TEMPLATE_REGISTRY[type];
    const row = overrides.get(type);
    return {
      type,
      label: spec.label,
      description: spec.description,
      default_subject_template: spec.default_subject_template,
      variables: spec.variables,
      override: row
        ? {
            subject_template: row.subject_template,
            body_template: row.body_template,
            updated_at: row.updated_at,
          }
        : null,
    };
  });

  return Response.json({ templates });
}
