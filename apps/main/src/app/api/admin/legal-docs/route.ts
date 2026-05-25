// §17.5 — Legal document management API.
// GET: list all document versions.
// POST: publish a new version (supersedes prior current version, flags affected users).

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdmin, PlatformAdminError } from "@/lib/auth/assert-platform-admin";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface PublishBody {
  document_type: string;
  content_markdown: string;
  summary_of_changes?: string;
  effective_at?: string;
}

const VALID_TYPES = ["tou","privacy_policy","ai_disclaimer","cookie_policy","ica_subhost","can_spam_addendum","tcpa_addendum"];

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_doc_publishing", operation: "legal_docs.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "legal_documents" });
        const { data, error } = await db
          .from("legal_documents")
          .select("id, document_type, version, summary_of_changes, effective_at, superseded_at, created_at")
          .order("document_type")
          .order("version", { ascending: false });

        if (error) throw new Error(error.message);
        return data;
      },
    );
    return Response.json({ documents: result });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdmin(req)).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: PublishBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!VALID_TYPES.includes(body.document_type)) {
    return Response.json({ error: "invalid_document_type" }, { status: 422 });
  }

  if (!body.content_markdown?.trim()) {
    return Response.json({ error: "content_markdown required" }, { status: 422 });
  }

  const effectiveAt = body.effective_at ?? new Date().toISOString();

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "help_doc_publishing", operation: "legal_docs.publish" },
      async (db, recordQuery) => {
        // Determine new version number.
        recordQuery({ op: "select", table: "legal_documents" });
        const { data: existing } = await db
          .from("legal_documents")
          .select("id, version")
          .eq("document_type", body.document_type)
          .order("version", { ascending: false })
          .limit(1);

        const prevVersion = existing?.[0] as { id: string; version: number } | undefined;
        const newVersion = (prevVersion?.version ?? 0) + 1;

        // Supersede the previous current version.
        if (prevVersion) {
          recordQuery({ op: "update", table: "legal_documents" });
          await db.from("legal_documents").update({ superseded_at: effectiveAt }).eq("id", prevVersion.id);
        }

        // Insert new version.
        recordQuery({ op: "insert", table: "legal_documents" });
        const { data: newDoc, error: insertErr } = await db.from("legal_documents").insert({
          document_type: body.document_type,
          version: newVersion,
          content_markdown: body.content_markdown,
          ...(body.summary_of_changes ? { summary_of_changes: body.summary_of_changes } : {}),
          effective_at: effectiveAt,
          created_by_user_id: adminUserId,
        }).select("id, version").single();

        if (insertErr || !newDoc) throw new Error(insertErr?.message ?? "Insert failed");

        // Find all users whose latest accepted version < new version and flag for re-consent.
        recordQuery({ op: "select", table: "legal_consents" });
        const { data: usersToFlag } = await db
          .from("legal_consents")
          .select("auth_user_id")
          .eq("document_type", body.document_type)
          .lt("document_version", newVersion)
          .eq("action", "accepted");

        if (usersToFlag && usersToFlag.length > 0) {
          const uniqueUsers = [...new Set((usersToFlag as { auth_user_id: string }[]).map((r) => r.auth_user_id))];
          recordQuery({ op: "insert", table: "user_consent_pending", row_count: uniqueUsers.length });

          for (const authUserId of uniqueUsers) {
            await db.from("user_consent_pending").upsert({
              auth_user_id: authUserId,
              document_type: body.document_type,
              document_id_pending: (newDoc as { id: string }).id,
              flagged_at: new Date().toISOString(),
            }, { onConflict: "auth_user_id,document_type" });
          }

          console.info("[legal-docs] Flagged %d users for re-consent on %s v%d", uniqueUsers.length, String(body.document_type).replace(/[\r\n]/g, " "), newVersion);

          // Notify affected users. Best-effort — the user_consent_pending
          // rows are the durable signal; the email is a convenience.
          try {
            const { sendPlatformUserEmail } = await import("@/lib/email/notifications");
            const summary = body.summary_of_changes ?? "Please review the updated document.";
            const subject = `Updated terms — please review (${body.document_type} v${newVersion})`;
            // Look up email addresses via the auth admin API one-by-one.
            for (const authUserId of uniqueUsers) {
              try {
                const { data: au } = await db.auth.admin.getUserById(authUserId);
                const to = au?.user?.email;
                if (!to) continue;
                await sendPlatformUserEmail({
                  to,
                  subject,
                  html: `<h2>Updated terms — your review is needed</h2>
                    <p>We've published version ${newVersion} of our ${escapeHtml(body.document_type)}.</p>
                    <p><strong>Summary of changes:</strong></p>
                    <p>${escapeHtml(summary)}</p>
                    <p>You'll be asked to re-consent the next time you sign in.</p>`,
                });
              } catch (perUserErr) {
                console.warn(
                  "[legal-docs] notification for user %s failed: %s",
                  authUserId,
                  perUserErr instanceof Error ? perUserErr.message : String(perUserErr),
                );
              }
            }
          } catch (notifyErr) {
            console.warn(
              "[legal-docs] notification pass failed: %s",
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            );
          }
        }

        return { document_id: (newDoc as { id: string }).id, version: newVersion };
      },
    );

    return Response.json({ ok: true, ...result });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
