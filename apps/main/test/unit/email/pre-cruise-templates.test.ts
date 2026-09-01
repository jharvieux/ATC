import { describe, it, expect } from "vitest";
import * as React from "react";
import * as ReactDOMServer from "react-dom/server";
import { PreCruiseT1 } from "@/emails/PreCruiseT1";
import { PreCruiseT90 } from "@/emails/PreCruiseT90";
import { PreCruiseT30 } from "@/emails/PreCruiseT30";
import { PreCruiseT7 } from "@/emails/PreCruiseT7";

const baseLayout = {
  branding: {},
  tenant_legal_name: "Test Agency",
  tenant_business_address: "123 Main St",
  unsubscribe_url: "https://example.com/unsubscribe",
};

describe("PreCruiseT1 — §23.4 carry-on essentials callout", () => {
  it("contains the hardcoded CARRY-ON ESSENTIALS callout", () => {
    const jsx = React.createElement(PreCruiseT1, {
      layout: baseLayout,
      customer_name: "Alice",
      ship_name: "Wonder of the Seas",
      departure_port: null,
      first_port_preview: "First port preview text.",
      day_of_expectations: "Day of expectations text.",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("CARRY-ON ESSENTIALS");
    expect(html).toContain("Passport and travel documents");
    expect(html).toContain("Cruise paperwork");
    expect(html).toContain("Medications you take regularly");
    expect(html).toContain("Checked luggage doesn");
    expect(html).toContain("background-color:#fffbeb");
    expect(html).toContain("border:2px solid #b45309");
  });

  it("renders port info when departure_port is provided", () => {
    const jsx = React.createElement(PreCruiseT1, {
      layout: baseLayout,
      customer_name: "Bob",
      ship_name: "Ship",
      departure_port: {
        port_name: "PortMiami",
        official_url: "https://www.miamidade.gov/portmiami/",
        arrival_advice: "Arrive 2 hours before departure.",
      },
      first_port_preview: "Preview",
      day_of_expectations: "Expectations",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("PortMiami");
    expect(html).toContain("Official port website");
    expect(html).toContain("Arrive 2 hours before departure.");
  });

  it("renders terminal_addresses table when provided", () => {
    const jsx = React.createElement(PreCruiseT1, {
      layout: baseLayout,
      customer_name: "Cara",
      ship_name: "Ship",
      departure_port: {
        port_name: "PortMiami",
        terminal_addresses: [
          { terminal: "Terminal B (NCL)", address: "1015 N Cruise Blvd, Miami, FL 33132" },
          { terminal: "Terminal A (Carnival)", address: "2001 N America Way, Miami, FL 33132" },
        ],
      },
      first_port_preview: "Preview",
      day_of_expectations: "Expectations",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("Terminal B (NCL)");
    expect(html).toContain("1015 N Cruise Blvd, Miami, FL 33132");
    expect(html).toContain("Terminal A (Carnival)");
    expect(html).toContain("2001 N America Way, Miami, FL 33132");
  });

  it("renders parking_info paragraph when provided", () => {
    const jsx = React.createElement(PreCruiseT1, {
      layout: baseLayout,
      customer_name: "Dana",
      ship_name: "Ship",
      departure_port: {
        port_name: "PortMiami",
        parking_info: "Cruise Parking Garage on-site: $22/day. Pre-payment via the PortMiami app.",
      },
      first_port_preview: "Preview",
      day_of_expectations: "Expectations",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("Parking:");
    expect(html).toContain("$22/day");
    expect(html).toContain("Pre-payment via the PortMiami app");
  });
});

describe("PreCruiseT90 — §23.4", () => {
  it("renders without error and includes customer name", () => {
    const jsx = React.createElement(PreCruiseT90, {
      layout: baseLayout,
      customer_name: "Charlie",
      ship_name: "Ship",
      cruise_line: "Royal Caribbean",
      sailing_date: "2026-07-01",
      ports: ["Miami", "Nassau"],
      documentation_reminder: "Check your passport.",
      destination_teaser: "Nassau awaits!",
      must_do_experiences: ["Snorkeling at Atlantis"],
      did_you_know: "Nassau has the clearest waters.",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("Charlie");
    expect(html).toContain("Royal Caribbean");
    expect(html).toContain("Nassau awaits!");
    expect(html).toContain("Your voyage briefing");
    expect(html).toContain("The horizon is getting closer.");
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
  });

  // #975 — T-90 gained the companion-page CTA in the marketing-grade redesign.
  it("renders the companion-page CTA when companion_page_url is provided", () => {
    const jsx = React.createElement(PreCruiseT90, {
      layout: baseLayout,
      customer_name: "Charlie",
      ship_name: "Ship",
      cruise_line: "Royal Caribbean",
      sailing_date: "2026-07-01",
      ports: [],
      documentation_reminder: "Check your passport.",
      destination_teaser: "Nassau awaits!",
      must_do_experiences: [],
      did_you_know: "Fact.",
      companion_page_url: "https://example.com/companion/tok90",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("https://example.com/companion/tok90");
  });
});

describe("PreCruiseT30 — §23.4", () => {
  it("renders without error and includes companion URL", () => {
    const jsx = React.createElement(PreCruiseT30, {
      layout: baseLayout,
      customer_name: "Dana",
      ship_name: "Symphony",
      sailing_date: "2026-07-01",
      reservation_reminders: ["Book specialty dining"],
      checkin_window: "Check in opens 45 days before sailing.",
      personalized_recommendations: ["Sushi restaurant"],
      specialty_experiences: ["Chef’s table"],
      pack_inspiration: "Pack light for the tropics.",
      companion_page_url: "https://example.com/companion/token123",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("Dana");
    expect(html).toContain("companion/token123");
    expect(html).toContain("Your departure edit");
    expect(html).toContain("Put this on your calendar");
    expect(html).toContain("Worth reserving");
    expect(html).toContain("Chef’s table");
  });
});

describe("PreCruiseT7 — §23.4", () => {
  it("renders without error and shows packing checklist", () => {
    const jsx = React.createElement(PreCruiseT7, {
      layout: baseLayout,
      customer_name: "Eve",
      ship_name: "Harmony",
      sailing_date: "2026-07-01",
      packing_checklist: ["Passport", "Sunscreen", "Formal wear"],
      ship_highlights: ["Central Park", "Boardwalk"],
      cruise_line_tips: ["Board early for deck chairs"],
      embarkation_advice: "Arrive at port by 11am.",
      first_day_inspiration: "Your first day aboard is magical.",
    });
    const html = ReactDOMServer.renderToStaticMarkup(jsx);
    expect(html).toContain("Eve");
    expect(html).toContain("Sunscreen");
    expect(html).toContain("Arrive at port by 11am.");
    expect(html).toContain("Your final week");
    expect(html).toContain("Embarkation day, made easy");
  });
});
