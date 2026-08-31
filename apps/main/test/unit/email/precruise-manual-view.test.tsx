// §23.4 — the staff menu surface must expose all four templates and both
// delivery modes; otherwise the API capability is effectively unreachable.

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PreCruiseEmailsView } from "@/app/(tenant)/crm/pre-cruise-emails/_components/PreCruiseEmailsView";

describe("PreCruiseEmailsView", () => {
  it("renders the complete four-phase manual delivery workflow", () => {
    const html = renderToStaticMarkup(<PreCruiseEmailsView />);

    expect(html).toContain("Pre-cruise emails");
    expect(html).toContain("T−90 days");
    expect(html).toContain("T−30 days");
    expect(html).toContain("T−7 days");
    expect(html).toContain("T−1 day");
    expect(html).toContain("Send now");
    expect(html).toContain("Schedule");
    expect(html).toContain("each phase sends only once per booking");
  });
});
