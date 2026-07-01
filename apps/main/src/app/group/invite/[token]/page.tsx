// §18.5 — Invitee canonical landing page.
// Validates the token server-side (five checks, via the API route); renders
// the group-landing redesign (specs/design_handoff_group_landing/) if valid.
//
// Deliberately does NOT render <TenantTheme/> — that injects the tenant's
// colors/font as unscoped :root CSS, which would override this page's fixed
// "Bright & Vacation-y" identity. Tenant branding here is limited to the
// nav's logo + <title>/favicon, matching the design's own scope.

import type { Metadata } from "next";
import { getRequestTenantBranding } from "@/lib/branding/request-branding";
import { GroupInviteView } from "@/components/group-invite/GroupInviteView";
import type { InviteData } from "@/components/group-invite/types";

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getRequestTenantBranding();
  if (!branding) return {};
  return {
    title: branding.display_name,
    ...(branding.favicon_url ? { icons: { icon: branding.favicon_url } } : {}),
  };
}

type PageProps = { params: Promise<{ token: string }> };

async function fetchInviteData(token: string, origin: string): Promise<{ data?: InviteData; error?: string; reason?: string }> {
  const res = await fetch(`${origin}/api/groups/invite/${encodeURIComponent(token)}`, { cache: "no-store" });
  const body = (await res.json()) as InviteData & { error?: string; reason?: string };
  if (!res.ok) {
    const result: { data?: InviteData; error?: string; reason?: string } = { error: body.error ?? "unknown_error" };
    if (body.reason !== undefined) result.reason = body.reason;
    return result;
  }
  return { data: body };
}

const REASON_MESSAGES: Record<string, string> = {
  expired_natural: "This invitation has expired.",
  invitee_removed: "You have been removed from this trip invitation.",
};

export default async function InvitePage(props: PageProps) {
  const params = await props.params;
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const [{ data, error, reason }, branding] = await Promise.all([
    fetchInviteData(params.token, origin),
    getRequestTenantBranding(),
  ]);

  if (error || !data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#f4faff] p-8">
        <h1 className="text-[22px] font-bold text-[#0b3a52]">Invitation unavailable</h1>
        <p className="max-w-[400px] text-center text-[#5c7f91]">
          {(reason && REASON_MESSAGES[reason]) ?? "This invitation link is invalid or has been revoked. Please contact the trip coordinator."}
        </p>
      </main>
    );
  }

  return <GroupInviteView data={data} token={params.token} tenantLogoUrl={branding?.logo_url ?? null} />;
}
