// #1808 — GroupReminder sailing-date rendering under a negative-UTC-offset
// timezone. sailing_date is a date-only Postgres DATE column ("2026-07-06");
// parsed as UTC midnight per ISO 8601. Rendering it with toLocaleDateString
// and no timeZone would roll a negative-UTC-offset server back to the
// previous calendar day (the #1768 bug class). Mirrors the Pacific/Honolulu
// regression test added for lib/format-date.ts in PR #1806.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupReminder } from "@/emails/GroupReminder";

const BASE_LAYOUT = {
  branding: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
  tenant_legal_name: "Test Agency",
  tenant_business_address: "123 Main St",
  unsubscribe_url: "https://example.com/unsub",
} as const;

describe("GroupReminder — sailing_date under a negative-UTC-offset timezone", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "Pacific/Honolulu"; // UTC-10, no DST
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("renders the same calendar date as stored, not the day before", () => {
    const html = renderToStaticMarkup(
      React.createElement(GroupReminder, {
        layout: BASE_LAYOUT,
        invitee_name: "Jenna",
        cruise_line: "Norwegian Cruise Line",
        ship_name: "Norwegian Bliss",
        sailing_date: "2026-07-06",
        coordinator_message: null,
        hero_image_url: null,
      }),
    );
    expect(html).toContain("July 6, 2026");
    expect(html).not.toContain("July 5, 2026");
  });
});
