// #487 — buildEmail renders destination_image and cruise_forecast props.
//
// These tests verify that T-7 and T-1 pass the hero image URL to the
// <img> element and include the Open-Meteo attribution when a forecast
// is present. T-90 and T-30 render the hero image but never the forecast.
// Null values produce no image block and no forecast chart.
//
// URL assertions use the unique photo ID rather than the full URL because
// renderToStaticMarkup escapes `&` → `&amp;` in attribute values, so the
// full URL with query string won't match verbatim.

import { describe, it, expect } from "vitest";
import { buildEmail } from "@/inngest/precruise-generate-and-send";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";
import type { DailyForecast } from "@/lib/weather/cruise-forecast";

const LAYOUT = {
  branding: {
    logo_url: null,
    primary_color: null,
    secondary_color: null,
    accent_color: null,
    slogan: null,
  },
  tenant_legal_name: "Test Agency",
  tenant_business_address: "123 Main St",
  unsubscribe_url: "https://example.com/unsub",
};

const CARIBBEAN_IMAGE: DestinationImage = {
  url: "https://images.unsplash.com/photo-1655299417498-52f3a304c2a4?w=1200&q=80&auto=format&fit=crop",
  source_page_url: "https://unsplash.com/photos/P41tKN3uZhw",
  attribution: "Photo by Christian Lendl on Unsplash",
  alt_text: "A Caribbean beach with palm trees and turquoise water",
  width_px: 1200,
  height_px: 800,
};

// Unique stable fragment of the image URL — no `&` so no &amp; HTML-escaping issue.
const CARIBBEAN_URL_FRAGMENT = "photo-1655299417498-52f3a304c2a4";

const SEVEN_DAY_FORECAST: DailyForecast[] = [
  { date: "2026-08-28", port_name: "Miami", high_f: 88, low_f: 76, precipitation_in: 0.1, conditions: "Partly Cloudy" },
  { date: "2026-08-29", port_name: "At Sea", high_f: 85, low_f: 74, precipitation_in: 0, conditions: "Sunny" },
  { date: "2026-08-30", port_name: "Roatán", high_f: 90, low_f: 78, precipitation_in: 0.2, conditions: "Partly Cloudy" },
  { date: "2026-08-31", port_name: "Cozumel", high_f: 91, low_f: 79, precipitation_in: 0, conditions: "Sunny" },
  { date: "2026-09-01", port_name: "Harvest Caye", high_f: 89, low_f: 77, precipitation_in: 0.3, conditions: "Scattered Showers" },
  { date: "2026-09-02", port_name: "At Sea", high_f: 87, low_f: 75, precipitation_in: 0, conditions: "Sunny" },
  { date: "2026-09-03", port_name: "Miami", high_f: 88, low_f: 76, precipitation_in: 0, conditions: "Clear" },
];

// Default generatedContent for T-7 (used unless overridden per test).
const T7_CONTENT = {
  packing_checklist: ["Sunscreen", "Passport"],
  ship_highlights: ["Pool deck", "Specialty dining"],
  cruise_line_tips: ["Book early", "Explore the ship"],
  embarkation_advice: "Arrive early.",
  first_day_inspiration: "The ship is magnificent.",
};

const BASE_CTX = {
  layoutProps: LAYOUT,
  customerName: "Jordan",
  shipName: "Norwegian Bliss",
  cruiseLine: "Norwegian Cruise Line",
  sailingDate: "2026-08-28",
  ports: ["Roatán", "Cozumel", "Harvest Caye"],
  generatedContent: T7_CONTENT as Record<string, unknown>,
  companionPageUrl: "https://test.example.com/companion/tok",
  portInfo: null,
  destinationImage: CARIBBEAN_IMAGE,
  cruiseForecast: SEVEN_DAY_FORECAST,
};

describe("buildEmail — destination_image rendering", () => {
  it("T-7: renders the caribbean image URL in an <img> tag", async () => {
    const { html } = await buildEmail("t_7", BASE_CTX);
    expect(html).toContain(CARIBBEAN_URL_FRAGMENT);
  });

  it("T-7: renders the caribbean image alt text", async () => {
    const { html } = await buildEmail("t_7", BASE_CTX);
    expect(html).toContain(CARIBBEAN_IMAGE.alt_text);
  });

  it("T-7: renders the image attribution line in the footer", async () => {
    const { html } = await buildEmail("t_7", BASE_CTX);
    expect(html).toContain(CARIBBEAN_IMAGE.attribution);
  });

  it("T-1: renders the caribbean image URL in an <img> tag", async () => {
    const { html } = await buildEmail("t_1", {
      ...BASE_CTX,
      generatedContent: { first_port_preview: "Great", day_of_expectations: "Early" },
    });
    expect(html).toContain(CARIBBEAN_URL_FRAGMENT);
  });

  it("T-90: renders the caribbean image URL", async () => {
    const { html } = await buildEmail("t_90", {
      ...BASE_CTX,
      generatedContent: {
        documentation_reminder: "r", destination_teaser: "t",
        must_do_experiences: [], did_you_know: "d", suggested_reads: [],
      },
    });
    expect(html).toContain(CARIBBEAN_URL_FRAGMENT);
  });

  it("T-30: renders the caribbean image URL", async () => {
    const { html } = await buildEmail("t_30", {
      ...BASE_CTX,
      generatedContent: {
        reservation_reminders: [], checkin_window: "c",
        final_payment_note: null, personalized_recommendations: [],
        specialty_experiences: ["Chef-led market tour"], pack_inspiration: "p",
      },
    });
    expect(html).toContain(CARIBBEAN_URL_FRAGMENT);
    expect(html).toContain("Chef-led market tour");
  });

  it("T-7: omits image block when destinationImage is null", async () => {
    const { html } = await buildEmail("t_7", { ...BASE_CTX, destinationImage: null });
    expect(html).not.toContain(CARIBBEAN_URL_FRAGMENT);
  });
});

describe("buildEmail — cruise_forecast rendering", () => {
  it("T-7: renders Open-Meteo attribution when forecast present", async () => {
    const { html } = await buildEmail("t_7", BASE_CTX);
    expect(html).toContain("Open-Meteo");
  });

  it("T-7: renders all 7 port names from the forecast", async () => {
    const { html } = await buildEmail("t_7", BASE_CTX);
    for (const day of SEVEN_DAY_FORECAST) {
      expect(html).toContain(day.port_name);
    }
  });

  it("T-1: renders Open-Meteo attribution when forecast present", async () => {
    const { html } = await buildEmail("t_1", {
      ...BASE_CTX,
      generatedContent: { first_port_preview: "Great", day_of_expectations: "Early" },
    });
    expect(html).toContain("Open-Meteo");
  });

  it("T-7: omits Open-Meteo attribution when cruiseForecast is null", async () => {
    const { html } = await buildEmail("t_7", { ...BASE_CTX, cruiseForecast: null });
    expect(html).not.toContain("Open-Meteo");
  });

  it("T-90: never renders forecast chart (no cruise_forecast prop)", async () => {
    const { html } = await buildEmail("t_90", {
      ...BASE_CTX,
      generatedContent: {
        documentation_reminder: "r", destination_teaser: "t",
        must_do_experiences: [], did_you_know: "d", suggested_reads: [],
      },
    });
    expect(html).not.toContain("Open-Meteo");
  });
});
