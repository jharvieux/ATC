// Intent: BrandedLayout is the single footer every branded email renders through.
// mailing_address is a JSONB column ({line1,city,state,zip,country}); if any call
// site forgets to coerce it and passes the raw object, BrandedLayout must NOT
// throw "Objects are not valid as a React child" (which 500s the send). The
// defensive coercion here guards the whole email-flow surface against the #1553
// bug class — including future callers that the per-site fixes can't anticipate.

import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandedLayout } from "@/emails/BrandedLayout";

const BASE = {
  branding: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null },
  tenant_legal_name: "Test Agency",
  unsubscribe_url: "https://example.com/unsub",
} as const;

describe("BrandedLayout — defensive mailing_address coercion (#1553)", () => {
  it("renders a raw JSONB object address as a flat string without throwing", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        BrandedLayout,
        {
          ...BASE,
          // The exact JSONB shape that 500'd broadcasts/invites before the sweep.
          tenant_business_address: {
            line1: "1 Main St", city: "Miami", state: "FL", zip: "33101", country: "US",
          } as unknown as string,
        },
        React.createElement("p", null, "Body"),
      ),
    );
    expect(html).toContain("1 Main St, Miami, FL 33101, US");
    expect(html).not.toContain("[object Object]");
  });

  it("passes a plain string address through unchanged", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        BrandedLayout,
        { ...BASE, tenant_business_address: "456 Oak Ave, Dallas, TX" },
        React.createElement("p", null, "Body"),
      ),
    );
    expect(html).toContain("456 Oak Ave, Dallas, TX");
  });
});
