// §17.9 — Assembles a CCPA data export ZIP for the requesting user.
// Triggered by the user.data_export_requested event.
// Uploads to Supabase Storage and emails the user a signed URL.

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { signServiceJwt } from "@/lib/rag-auth/sign-service-jwt";
import { PLATFORM_SENTINEL_TENANT_ID } from "@/lib/rag-auth/platform-sentinel";
import { safeAwait } from "@/lib/db/safe-mutation";

const ExportPayloadSchema = z.object({
  auth_user_id: z.string(),
  export_request_id: z.string(),
});

interface RagExportResponse {
  ok?: boolean;
  chunks?: Array<Record<string, unknown>>;
  error?: string;
}

type ExportDb = Pick<ReturnType<typeof createServiceRoleClient>, "from">;

// §17.9 — gather the requesting user's CCPA-disclosable rows from the main DB.
// Exported for testing; the Inngest handler around it is otherwise hard to
// exercise. D-091 Round-3 #46 — explicit column allowlists (never select('*'),
// which would leak internal fields into the export).
// #1190: bookings + conversations link by user_id (= users.id), NOT
// auth_user_id — resolve the platform users.id first; the users row and
// legal_consents carry auth_user_id directly.
export async function collectUserDbExport(
  db: ExportDb,
  auth_user_id: string,
): Promise<{
  user_profile: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
  legal_consents: Array<Record<string, unknown>>;
}> {
  const { data: userRows } = await db
    .from("users")
    .select(
      "id, email, display_name, first_name, last_name, " +
        "preferred_persona_slug, marketing_email_opt_in, travel_news_opt_in, " +
        "memory_opt_out, notif_preferences, email_status, " +
        "last_signed_in_at, created_at, updated_at",
    )
    .eq("auth_user_id", auth_user_id);

  const usersId = (userRows?.[0] as { id?: string } | undefined)?.id ?? null;

  const [{ data: convRows }, { data: bookingRows }] = usersId
    ? await Promise.all([
        db
          .from("conversations")
          .select(
            "id, status, active_persona_id, first_message_at, last_message_at, " +
              "message_count, created_at, updated_at",
          )
          .eq("user_id", usersId),
        db
          .from("bookings")
          // #1190: real columns — bookings has no source/booked_at/sailed_at.
          .select(
            "id, status, cruise_line, ship_name, sailing_date, " +
              "total_amount_cents, currency, confirmed_at, submitted_at, " +
              "cancelled_at, created_at, updated_at",
          )
          .eq("user_id", usersId),
      ])
    : [{ data: [] }, { data: [] }];

  const { data: consentRows } = await db
    .from("legal_consents")
    // #1190: real columns are document_type/document_version/acted_at.
    .select("id, document_type, document_version, acted_at, ip_address, user_agent")
    .eq("auth_user_id", auth_user_id);

  // supabase-js types data as GenericStringError[] for these selects; the rows
  // are opaque export payload, so widen through unknown.
  return {
    user_profile: (userRows ?? []) as unknown as Array<Record<string, unknown>>,
    conversations: (convRows ?? []) as unknown as Array<Record<string, unknown>>,
    bookings: (bookingRows ?? []) as unknown as Array<Record<string, unknown>>,
    legal_consents: (consentRows ?? []) as unknown as Array<Record<string, unknown>>,
  };
}

export const userDataExportBuild = inngest.createFunction(
  {
    id: "user-data-export-build",
    triggers: [{ event: "user.data_export_requested" }],
  },
  async ({ event }) => {
    const parsed = ExportPayloadSchema.safeParse(event.data);
    if (!parsed.success) {
      console.error("[user-data-export-build] invalid event payload: %s", parsed.error.message);
      return { skipped: true, reason: "invalid_payload" };
    }
    const { auth_user_id, export_request_id } = parsed.data;
    const db = createServiceRoleClient();

    // Gather the user's main-DB rows (see collectUserDbExport for the
    // column-allowlist + user_id-resolution rationale).
    const dbExport = await collectUserDbExport(db, auth_user_id);

    // Knowledge-chunks live on the RAG service; fetch via signed service JWT.
    // Failures are non-fatal — we record an empty array + the error so the
    // user still gets the rest of their data within the 45-day SLA.
    let knowledgeChunks: Array<Record<string, unknown>> = [];
    let knowledgeChunksError: string | null = null;
    const ragUrl = process.env.RAG_SERVICE_URL;
    if (ragUrl) {
      try {
        const jwt = await signServiceJwt({
          tenant_id: PLATFORM_SENTINEL_TENANT_ID,
          scope: "read",
          service_identifier: "platform-admin",
        });
        const res = await fetch(`${ragUrl}/api/admin/export-user-chunks`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ auth_user_id }),
        });
        if (res.ok) {
          const json = (await res.json()) as RagExportResponse;
          knowledgeChunks = json.chunks ?? [];
        } else {
          knowledgeChunksError = `rag_export_http_${res.status}`;
        }
      } catch (e) {
        knowledgeChunksError = e instanceof Error ? e.message : String(e);
      }
    } else {
      knowledgeChunksError = "rag_service_url_unset";
    }

    const payload = {
      exported_at: new Date().toISOString(),
      user_profile: dbExport.user_profile,
      conversations: dbExport.conversations,
      bookings: dbExport.bookings,
      legal_consents: dbExport.legal_consents,
      knowledge_chunks: knowledgeChunks,
      ...(knowledgeChunksError ? { knowledge_chunks_error: knowledgeChunksError } : {}),
    };

    const jsonContent = JSON.stringify(payload, null, 2);

    const storagePath = `${auth_user_id}/${export_request_id}.json`;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    // Ensure the bucket exists. Idempotent: 409 (already exists) is fine.
    await ensureBucket(supabaseUrl, serviceKey, "user-exports");

    const uploadRes = await fetch(
      `${supabaseUrl}/storage/v1/object/user-exports/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: jsonContent,
      },
    );

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      console.error("[user-data-export-build] upload failed: %s", text);
      return { error: "upload_failed" };
    }

    // Create a signed URL valid for 24 hours.
    const signRes = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/user-exports/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 86400 }),
      },
    );

    let signedUrl: string | null = null;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    if (signRes.ok) {
      const signData = await signRes.json() as { signedURL?: string };
      signedUrl = signData.signedURL ?? null;
    }

    // Update the export request row.
    await safeAwait(db.from("user_data_export_requests").update({
      completed_at: new Date().toISOString(),
      signed_url: signedUrl,
      expires_at: expiresAt,
    }).eq("id", export_request_id), "user_data_export_requests.update");

    // Email the user the signed URL. Best-effort: the row is already
    // updated with signed_url so the user can also retrieve it from the
    // /api/user/data/export-request poll endpoint if email fails.
    if (signedUrl) {
      try {
        const { data: authUser } = await db.auth.admin.getUserById(auth_user_id);
        const recipientEmail = authUser?.user?.email ?? null;
        if (recipientEmail) {
          const { sendPlatformUserEmail } = await import("@/lib/email/notifications");
          await sendPlatformUserEmail({
            to: recipientEmail,
            subject: "Your data export is ready",
            html: `
              <h2>Your data export is ready</h2>
              <p>Per your request, we've prepared an export of your account data.</p>
              <p><a href="${signedUrl}">Download the ZIP</a> — the link expires
              in 24 hours.</p>
              <p>If you didn't request this, please reply to this email immediately.</p>
            `,
          });
        }
      } catch (notifyErr) {
        console.warn(
          "[user-data-export-build] email failed: %s",
          notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        );
      }
    }
    console.info(
      "[user-data-export-build] export complete for user=%s url=%s",
      auth_user_id,
      signedUrl,
    );

    return { ok: true, signed_url: signedUrl };
  },
);

async function ensureBucket(supabaseUrl: string, serviceKey: string, bucketId: string): Promise<void> {
  const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: bucketId, name: bucketId, public: false }),
  });
  // 200/201 created; 409/400 already-exists; 4xx anything else is logged but
  // not fatal — the subsequent upload will surface the real failure.
  if (!res.ok && res.status !== 409 && res.status !== 400) {
    const text = await res.text().catch(() => "");
    console.warn("[user-data-export-build] ensureBucket non-fatal: %s %s", res.status, text);
  }
}
