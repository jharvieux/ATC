// Unit tests — server→client data-leak detector (M9, heuristic). Intent: flag an
// object SPREAD onto a known Client Component from a server file; ignore client
// files and unknown components.
import { describe, it, expect } from "vitest";
import { clientComponentNames, findClientLeakSpreads } from "../../../scripts/check-client-data-leak";

describe("clientComponentNames", () => {
  it("extracts exports from a 'use client' module", () => {
    const n = clientComponentNames(`'use client'\nexport function Widget(){}\nexport const Panel = () => null`);
    expect(n).toContain("Widget");
    expect(n).toContain("Panel");
  });
  it("returns nothing for a server module", () => {
    expect(clientComponentNames(`export function Widget(){}`)).toEqual([]);
  });
});

describe("findClientLeakSpreads", () => {
  const clients = new Set(["Widget"]);
  it("flags a spread onto a known Client Component in a server file", () => {
    const r = findClientLeakSpreads("apps/main/src/app/x/page.tsx", `<Widget {...row} />`, clients);
    expect(r).toEqual([{ component: "Widget", line: 1 }]);
  });
  it("ignores a spread onto an unknown (server) component", () => {
    expect(findClientLeakSpreads("apps/main/src/app/x/page.tsx", `<ServerCard {...row} />`, clients)).toEqual([]);
  });
  it("ignores spreads inside a 'use client' file", () => {
    expect(findClientLeakSpreads("apps/main/src/x.tsx", `'use client'\n<Widget {...row} />`, clients)).toEqual([]);
  });
  it("does not flag explicit props (no spread)", () => {
    expect(findClientLeakSpreads("apps/main/src/app/x/page.tsx", `<Widget id={row.id} />`, clients)).toEqual([]);
  });
});
