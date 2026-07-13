// Shared variable-population + layout builder for the email-template preview
// and send-preview routes (#1608). Both routes MUST derive identical vars and
// layout for the same (type, sailing_id | booking_id) input — what the
// preview SHOWS has to match what send-preview actually SENDS.
//
// Used by:
//   GET  /api/tenant/email-templates/[type]/preview
//   POST /api/tenant/email-templates/[type]/send-preview

import type { SupabaseClient } from "@supabase/supabase-js";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import type { EmailTemplateSpec } from "@/lib/email/template-registry";
import { formatMailingAddress } from "@/lib/email/format-mailing-address";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";

export interface PreviewTenantRow {
  legal_name: string | null;
  mailing_address: string | null;
}

export interface PreviewBrandingRow {
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  slogan: string | null;
}

interface SailingWithShip {
  departure_date: string;
  departure_port: string;
  cruise_ships: { canonical_name: string; cruise_lines: { display_name: string } | null } | null;
}

interface BookingWithContact {
  ship_name: string | null;
  cruise_line: string | null;
  sailing_date: string | null;
  contacts: { first_name: string | null; last_name: string | null } | null;
}

export function layoutFromRows(
  tenant: PreviewTenantRow,
  branding: PreviewBrandingRow | null,
): Omit<BrandedLayoutProps, "children"> {
  return {
    branding: {
      logo_url: branding?.logo_url ?? null,
      primary_color: branding?.primary_color ?? null,
      secondary_color: branding?.secondary_color ?? null,
      accent_color: branding?.accent_color ?? null,
      slogan: branding?.slogan ?? null,
    },
    tenant_legal_name: tenant.legal_name ?? "Your Agency",
    tenant_business_address: formatMailingAddress(tenant.mailing_address),
    unsubscribe_url: `${APP_URL}/email/unsubscribe?token=preview`,
  };
}

export type PreviewVarsResult =
  | { ok: true; vars: Record<string, string> }
  | { ok: false; response: Response };

// Registry sample values, overlaid with real sailing/booking data when a
// sailing_id or booking_id is supplied. `db` is always the caller's
// tenantClient(ctx) — the tenant-scoping proxy provides isolation.
export async function buildPreviewVars(
  db: SupabaseClient,
  spec: EmailTemplateSpec,
  sailingId: string | null,
  bookingId: string | null,
): Promise<PreviewVarsResult> {
  const vars: Record<string, string> = {};
  for (const v of spec.variables) {
    vars[v.name] = v.sample;
  }

  if (sailingId) {
    const { data, error } = await db
      // d091-allow:service-role-tenant db = caller's tenantClient (RLS-scoped proxy), not service-role; proxy provides isolation
      .from("cruise_sailings")
      .select(
        "departure_date, departure_port, cruise_ships(canonical_name, cruise_lines(display_name))",
      )
      .eq("id", sailingId)
      .single();

    if (error) return { ok: false, response: dbErrorResponse(error) };
    const row = data as unknown as SailingWithShip;
    if (row.departure_date) vars.sailing_date = row.departure_date;
    if (row.departure_port) vars.departure_port = row.departure_port;
    if (row.cruise_ships?.canonical_name) vars.ship_name = row.cruise_ships.canonical_name;
    if (row.cruise_ships?.cruise_lines?.display_name)
      vars.cruise_line = row.cruise_ships.cruise_lines.display_name;
  } else if (bookingId) {
    const { data, error } = await db
      // d091-allow:service-role-tenant db = caller's tenantClient (RLS-scoped proxy), not service-role; proxy provides isolation
      .from("bookings")
      .select(
        "ship_name, cruise_line, sailing_date, contacts!primary_contact_id(first_name, last_name)",
      )
      .eq("id", bookingId)
      .single();

    if (error) return { ok: false, response: dbErrorResponse(error) };
    const row = data as unknown as BookingWithContact;
    if (row.ship_name) vars.ship_name = row.ship_name;
    if (row.cruise_line) vars.cruise_line = row.cruise_line;
    if (row.sailing_date) vars.sailing_date = row.sailing_date;
    const contact = row.contacts;
    if (contact) {
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ");
      if (name) {
        vars.customer_name = name;
        vars.recipient_name = name;
        vars.invitee_name = name;
      }
    }
  }

  return { ok: true, vars };
}
