// Shared email preview renderer for the "send to me" and full-preview endpoints.
//
// Renders the platform-default React Email component for a given template type
// with caller-supplied variables. AI-content fields use bracketed placeholder
// text so the preview is structurally accurate without a live AI call.
//
// Used by:
//   GET  /api/tenant/email-templates/[type]/preview
//   POST /api/tenant/email-templates/[type]/send-preview

import * as React from "react";
import type { BrandedLayoutProps } from "@/emails/BrandedLayout";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ai-travelconcierge.com";

export async function buildPreviewHtml(
  type: string,
  vars: Record<string, string>,
  layout: Omit<BrandedLayoutProps, "children">,
): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");

  switch (type) {
    case "pre_cruise_t_90": {
      const { PreCruiseT90 } = await import("@/emails/PreCruiseT90");
      return renderToStaticMarkup(
        React.createElement(PreCruiseT90, {
          layout,
          customer_name: vars.customer_name ?? "Alice Rivera",
          ship_name: vars.ship_name ?? "Wonder of the Seas",
          cruise_line: vars.cruise_line ?? "Royal Caribbean",
          sailing_date: vars.sailing_date ?? "2026-09-12",
          ports: [],
          destination_image: null,
          documentation_reminder:
            "[Preview] Check passport validity — must be valid for 6+ months past your return date.",
          destination_teaser:
            "[Preview] AI-generated destination highlights will be personalized for your customer.",
          must_do_experiences: [
            "[Preview] Personalized experience recommendation 1.",
            "[Preview] Personalized experience recommendation 2.",
          ],
          did_you_know: "[Preview] A fun fact about your customer's destination will appear here.",
          companion_page_url: vars.companion_page_url || `${APP_URL}/companion/preview`,
        }),
      );
    }

    case "pre_cruise_t_30": {
      const { PreCruiseT30 } = await import("@/emails/PreCruiseT30");
      return renderToStaticMarkup(
        React.createElement(PreCruiseT30, {
          layout,
          customer_name: vars.customer_name ?? "Alice Rivera",
          ship_name: vars.ship_name ?? "Wonder of the Seas",
          sailing_date: vars.sailing_date ?? "2026-09-12",
          destination_image: null,
          reservation_reminders: [
            "[Preview] Specialty restaurant reservations fill up — book now in the cruise line app.",
            "[Preview] Excursions at popular ports sell out; reserve through the cruise line for peace of mind.",
          ],
          checkin_window:
            "[Preview] Online check-in opens 90 days before sailing — complete it early to select your boarding time.",
          final_payment_note: null,
          personalized_recommendations: [
            "[Preview] AI-curated recommendation for your customer will appear here.",
          ],
          pack_inspiration:
            "[Preview] AI-generated packing tips tailored to your customer's itinerary.",
          companion_page_url: vars.companion_page_url || `${APP_URL}/companion/preview`,
        }),
      );
    }

    case "pre_cruise_t_7": {
      const { PreCruiseT7 } = await import("@/emails/PreCruiseT7");
      return renderToStaticMarkup(
        React.createElement(PreCruiseT7, {
          layout,
          customer_name: vars.customer_name ?? "Alice Rivera",
          ship_name: vars.ship_name ?? "Wonder of the Seas",
          sailing_date: vars.sailing_date ?? "2026-09-12",
          destination_image: null,
          cruise_forecast: null,
          packing_checklist: [
            "[Preview] Passport + printed boarding pass",
            "[Preview] Reef-safe sunscreen SPF 50+",
            "[Preview] Medications (carry-on only)",
          ],
          ship_highlights: [
            `[Preview] ${vars.ship_name ?? "This ship"} has a feature your customer will love.`,
            "[Preview] Another ship highlight AI tailors to their sailing.",
          ],
          cruise_line_tips: [
            `[Preview] ${vars.cruise_line ?? "This cruise line"} tip for a smoother boarding.`,
          ],
          embarkation_advice:
            "[Preview] AI-generated embarkation advice for your customer's port.",
          first_day_inspiration:
            "[Preview] AI-generated first-day inspiration based on the itinerary.",
          companion_page_url: vars.companion_page_url || `${APP_URL}/companion/preview`,
        }),
      );
    }

    case "pre_cruise_t_1": {
      const { PreCruiseT1 } = await import("@/emails/PreCruiseT1");
      return renderToStaticMarkup(
        React.createElement(PreCruiseT1, {
          layout,
          customer_name: vars.customer_name ?? "Alice Rivera",
          ship_name: vars.ship_name ?? "Wonder of the Seas",
          departure_port: null,
          destination_image: null,
          first_port_preview:
            "[Preview] Your first stop awaits — AI writes a teaser of the first port experience.",
          day_of_expectations:
            "[Preview] What to expect on embarkation day — AI-generated for your customer.",
          cruise_forecast: null,
          weather_summary:
            "[Preview] A weather summary for the sailing will be generated closer to departure.",
          companion_page_url: vars.companion_page_url || `${APP_URL}/companion/preview`,
        }),
      );
    }

    case "group_invitation": {
      const { GroupInvitation } = await import("@/emails/GroupInvitation");
      return renderToStaticMarkup(
        React.createElement(GroupInvitation, {
          branding: layout.branding,
          tenant_legal_name: layout.tenant_legal_name,
          tenant_business_address: layout.tenant_business_address,
          unsubscribe_url: layout.unsubscribe_url,
          invitee_name: vars.invitee_name ?? null,
          cruise_line: vars.cruise_line ?? "Carnival",
          ship_name: vars.ship_name ?? "Mardi Gras",
          sailing_date: vars.sailing_date ?? "2026-11-03",
          departure_port: vars.departure_port ?? "Miami, FL",
          coordinator_message:
            vars.coordinator_message ||
            "Can't wait to sail with you all! This is going to be an amazing voyage.",
          hero_image_url: null,
          booked_count: 3,
          interested_count: 2,
          invite_url: vars.invite_url || `${APP_URL}/group/invite/preview`,
        }),
      );
    }

    case "group_reminder": {
      const { GroupReminder } = await import("@/emails/GroupReminder");
      return renderToStaticMarkup(
        React.createElement(GroupReminder, {
          layout,
          invitee_name: vars.invitee_name ?? null,
          cruise_line: vars.cruise_line ?? "Carnival",
          ship_name: vars.ship_name ?? "Mardi Gras",
          sailing_date: vars.sailing_date ?? "2026-11-03",
          coordinator_message: vars.coordinator_message || null,
          hero_image_url: null,
          invite_url: vars.invite_url || `${APP_URL}/group/invite/preview`,
        }),
      );
    }

    case "quote_estimate_expired": {
      const { QuoteEstimateExpiredEmail } = await import("@/emails/QuoteEstimateExpiredEmail");
      return renderToStaticMarkup(
        React.createElement(QuoteEstimateExpiredEmail, {
          layout,
          customer_name: vars.customer_name ?? "Alice Rivera",
          cruise_label: vars.cruise_label ?? null,
          refresh_url: vars.refresh_url || `${APP_URL}/quotes/preview/refresh`,
          validity_days: parseInt(vars.validity_days ?? "14", 10),
        }),
      );
    }

    case "task_reminder": {
      const { TaskReminder } = await import("@/emails/TaskReminder");
      return renderToStaticMarkup(
        React.createElement(TaskReminder, {
          branding: layout.branding,
          tenant_legal_name: layout.tenant_legal_name,
          tenant_business_address: layout.tenant_business_address,
          recipient_name: vars.recipient_name ?? "Alex Chen",
          task_title: vars.task_title ?? "Follow up with cruise quote",
          task_description: vars.task_description ?? "Client asked for Royal Caribbean options.",
          due_at: vars.due_at ?? null,
          priority: vars.priority ?? "high",
          task_url: vars.task_url || `${APP_URL}/crm/tasks/preview`,
          unsubscribe_url: layout.unsubscribe_url,
        }),
      );
    }

    default:
      return `<html><body><p>Unknown template type: ${type}</p></body></html>`;
  }
}
