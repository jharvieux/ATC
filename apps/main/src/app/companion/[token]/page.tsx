// §23.5 — Companion web page for pre-cruise emails.
//
// Token-gated (HMAC-signed, no auth required). Decodes to { booking_id, phase }.
// Renders richer content than the email: image galleries, detailed itineraries.
// Tenant branding applied via the tenant resolver middleware.

import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyCompanionToken } from "@/lib/email/unsubscribe-token";

interface PageProps {
  params: { token: string };
}

const PHASE_LABELS: Record<string, string> = {
  t_90: "90 Days Out",
  t_30: "30 Days Out",
  t_7:  "7 Days Out",
  t_1:  "Tomorrow!",
};

export default async function CompanionPage({ params }: PageProps) {
  const payload = verifyCompanionToken(params.token);
  if (!payload) notFound();

  const { booking_id, phase } = payload;
  const svc = createServiceRoleClient();

  const { data: content } = await svc
    .from("pre_cruise_email_content")
    .select("generated_content, booking_id")
    .eq("booking_id", booking_id)
    .eq("email_phase", phase)
    .maybeSingle();

  if (!content) notFound();

  const generated = (content as { generated_content: Record<string, unknown> }).generated_content;
  const phaseLabel = PHASE_LABELS[phase] ?? phase;

  return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "32px 16px", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ borderBottom: "2px solid #3b82f6", paddingBottom: 16, marginBottom: 32 }}>
        <h1 style={{ margin: 0, color: "#1f2937" }}>Your Voyage Guide — {phaseLabel}</h1>
      </header>

      {/* Render content sections generically from the JSONB blob */}
      {Object.entries(generated).map(([key, value]) => (
        <section key={key} style={{ marginBottom: 32 }}>
          <h2 style={{ color: "#374151", textTransform: "capitalize" }}>
            {key.replace(/_/g, " ")}
          </h2>
          {Array.isArray(value) ? (
            <ul>
              {(value as string[]).map((item, i) => (
                <li key={i} style={{ marginBottom: 6 }}>{item}</li>
              ))}
            </ul>
          ) : (
            <p style={{ lineHeight: 1.7, color: "#4b5563" }}>{String(value)}</p>
          )}
        </section>
      ))}

      <footer style={{ borderTop: "1px solid #e5e7eb", paddingTop: 16, color: "#9ca3af", fontSize: 13 }}>
        <p>This page is for your eyes only — no login required.</p>
      </footer>
    </main>
  );
}
