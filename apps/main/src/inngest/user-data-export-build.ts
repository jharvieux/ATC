// §17.9 — Assembles a CCPA data export ZIP for the requesting user.
// Triggered by the user.data_export_requested event.
// Uploads to Supabase Storage and emails the user a signed URL.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

interface ExportPayload {
  auth_user_id: string;
  export_request_id: string;
}

export const userDataExportBuild = inngest.createFunction(
  {
    id: "user-data-export-build",
    triggers: [{ event: "user.data_export_requested" }],
  },
  async ({ event }) => {
    const { auth_user_id, export_request_id } = event.data as ExportPayload;
    const db = createServiceRoleClient();

    // Gather all data for this user.
    const [
      { data: userRows },
      { data: convRows },
      { data: bookingRows },
      { data: consentRows },
    ] = await Promise.all([
      db.from("users").select("*").eq("auth_user_id", auth_user_id),
      db.from("conversations").select("*").eq("auth_user_id", auth_user_id),
      db.from("bookings").select("*").eq("auth_user_id", auth_user_id),
      db.from("legal_consents").select("*").eq("auth_user_id", auth_user_id),
    ]);

    // TODO(rag-export): include knowledge_chunks where ingest_user_id = auth_user_id
    // via RAG service call once ingest_user_id column is populated from BP17 migration.

    const payload = {
      exported_at: new Date().toISOString(),
      user_profile: userRows ?? [],
      conversations: convRows ?? [],
      bookings: bookingRows ?? [],
      legal_consents: consentRows ?? [],
    };

    const jsonContent = JSON.stringify(payload, null, 2);

    // Upload to Supabase Storage. The bucket 'user-exports' must exist.
    // TODO(storage-bucket): create user-exports bucket in Supabase dashboard.
    const storagePath = `${auth_user_id}/${export_request_id}.json`;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
    await db.from("user_data_export_requests").update({
      completed_at: new Date().toISOString(),
      signed_url: signedUrl,
      expires_at: expiresAt,
    }).eq("id", export_request_id);

    // TODO(notifications): email user via Resend with the signed URL.
    console.info("[user-data-export-build] export complete for user=%s url=%s", auth_user_id, signedUrl);

    return { ok: true, signed_url: signedUrl };
  },
);
