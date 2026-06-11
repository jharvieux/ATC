// §23.5 — Companion web page for pre-cruise emails.
//
// Token-gated (HMAC-signed, no auth required). Decodes to { booking_id, phase }.
// Renders richer content than the email: image galleries, detailed itineraries.
// Tenant branding applied via the tenant resolver middleware.

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { verifyCompanionToken } from "@/lib/email/unsubscribe-token";
import { TenantTheme } from "@/components/branding/TenantTheme";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";

// §16.2 — tenant subdomains show the tenant's name + favicon on companion pages.
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

interface PageProps {
  params: Promise<{ token: string }>;
}

const PHASE_LABELS: Record<string, string> = {
  t_90: "90 Days Out",
  t_30: "30 Days Out",
  t_7:  "7 Days Out",
  t_1:  "Tomorrow!",
};

export default async function CompanionPage(props: PageProps) {
  const params = await props.params;
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
    <main className="max-w-[700px] mx-auto px-4 py-8">
      {/* §16.2 — tenant colors/font when viewed on the tenant subdomain. */}
      <TenantTheme />
      <header className="border-b-2 border-blue-500 pb-4 mb-8">
        <h1 className="m-0 text-foreground">Your Voyage Guide — {phaseLabel}</h1>
      </header>
      {Object.entries(generated).map(([key, value]) => (
        <section key={key} className="mb-8">
          <h2 className="text-foreground capitalize">
            {key.replace(/_/g, " ")}
          </h2>
          {Array.isArray(value) ? (
            <ul>
              {(value as string[]).map((item, i) => (
                <li key={i} className="mb-1.5">{item}</li>
              ))}
            </ul>
          ) : (
            <p className="leading-[1.7] text-muted-foreground">{String(value)}</p>
          )}
        </section>
      ))}
      <footer className="border-t border-border pt-4 text-muted-foreground text-[13px]">
        <p>This page is for your eyes only — no login required.</p>
      </footer>
    </main>
  );
}
