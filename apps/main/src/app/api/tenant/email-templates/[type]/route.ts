// #963 — Tenant email template overrides: write endpoints (owner-only).
//
// PUT:    upsert the override for one email type. Unknown {{variables}} are
//         rejected HERE, at save time — never at send time (#963 acceptance).
// DELETE: reset to the platform default (drop the override row). Idempotent.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { respondToAuthError } from "@/lib/auth/respond";
import { safeAwait } from "@/lib/db/safe-mutation";
import { EMAIL_TEMPLATE_REGISTRY, bodyVariableNames, isEmailTemplateType } from "@/lib/email/template-registry";
import { validateTemplate, type TemplateValidationIssue } from "@/lib/email/template-engine";

type RouteProps = { params: Promise<{ type: string }> };

const SUBJECT_MAX = 300;
const BODY_MAX = 10000;

// Empty string and null both mean "no override for this part" — the UI sends
// whatever is in the text box. Distinguishing them would force the UI to
// null-out cleared fields client-side for no user-visible difference.
function normalize(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // type error sentinel
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PUT(req: Request, props: RouteProps): Promise<Response> {
  const { type } = await props.params;
  try {
    const { ctx, user } = await assertPermission(req, { resource: "email_templates", action: "write" });

    if (!isEmailTemplateType(type)) {
      return Response.json({ error: "unknown_email_type" }, { status: 404 });
    }
    const spec = EMAIL_TEMPLATE_REGISTRY[type];

    let body: { subject_template?: unknown; body_template?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const subjectTemplate = normalize(body.subject_template);
    const bodyTemplate = normalize(body.body_template);
    if (subjectTemplate === undefined || bodyTemplate === undefined) {
      return Response.json({ error: "templates_must_be_strings" }, { status: 400 });
    }
    if (subjectTemplate === null && bodyTemplate === null) {
      return Response.json(
        { error: "empty_override", detail: "Provide a subject or body; use DELETE to reset to the platform default." },
        { status: 400 },
      );
    }
    if (subjectTemplate && subjectTemplate.length > SUBJECT_MAX) {
      return Response.json({ error: "subject_too_long", max: SUBJECT_MAX }, { status: 422 });
    }
    if (bodyTemplate && bodyTemplate.length > BODY_MAX) {
      return Response.json({ error: "body_too_long", max: BODY_MAX }, { status: 422 });
    }

    // #975 — {{ai_content}} is body-only: the substituted value is
    // multi-paragraph text, never valid in a subject line.
    const issues: TemplateValidationIssue[] = [
      ...(subjectTemplate ? validateTemplate(subjectTemplate, spec.variables.map((v) => v.name)) : []),
      ...(bodyTemplate ? validateTemplate(bodyTemplate, bodyVariableNames(spec)) : []),
    ];
    if (issues.length > 0) {
      return Response.json({ error: "invalid_template", issues }, { status: 400 });
    }

    const db = tenantClient(ctx);
    await safeAwait(
      db.from("tenant_email_templates").upsert(
        {
          email_type: type,
          subject_template: subjectTemplate,
          body_template: bodyTemplate,
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,email_type" },
      ),
      "tenant_email_templates.upsert",
    );

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function DELETE(req: Request, props: RouteProps): Promise<Response> {
  const { type } = await props.params;
  try {
    const { ctx } = await assertPermission(req, { resource: "email_templates", action: "write" });

    if (!isEmailTemplateType(type)) {
      return Response.json({ error: "unknown_email_type" }, { status: 404 });
    }

    const db = tenantClient(ctx);
    await safeAwait(
      db.from("tenant_email_templates").delete().eq("email_type", type),
      "tenant_email_templates.delete",
    );

    return Response.json({ ok: true });
  } catch (err) {
    return respondToAuthError(err);
  }
}
