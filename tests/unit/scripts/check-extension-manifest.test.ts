// Unit tests — WebExtension manifest guard (Harvey Tier-1 port, refs #2000).
// Intent: the pre-#2015 manifest shape (broad https://*/* hosts + cookies) MUST
// fail, and the #2015-narrowed shape MUST pass — the guard exists to stop the
// broad combo from ever coming back once PR #2015 lands.
import { describe, it, expect } from "vitest";
import { findOverbroadCombos, loadBaseline } from "../../../scripts/check-extension-manifest";

// The literal pre-#2015 apps/extension/manifest.json shape (Harvey's #2000
// finding): broad host_permissions + the cookies capability.
const PRE_2015_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "ATC Knowledge Base Clipper",
  permissions: ["contextMenus", "storage", "cookies", "tabs"],
  host_permissions: ["https://*/*"],
});

// The narrowed shape PR #2015 moves to: origin-scoped host permissions.
const NARROWED_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: "ATC Knowledge Base Clipper",
  permissions: ["contextMenus", "storage", "cookies", "tabs"],
  host_permissions: ["https://tenant.aitravelconcierge.com/*"],
});

describe("findOverbroadCombos", () => {
  it("fails the pre-#2015 manifest: broad host + cookies/tabs", () => {
    const combos = findOverbroadCombos("apps/extension/manifest.json", PRE_2015_MANIFEST);
    expect(combos.map((c) => c.capability).sort()).toEqual(["cookies", "tabs"]);
    expect(combos.every((c) => c.broadHost === "https://*/*")).toBe(true);
  });

  it("passes the #2015-narrowed manifest clean", () => {
    expect(findOverbroadCombos("apps/extension/manifest.json", NARROWED_MANIFEST)).toEqual([]);
  });

  it("flags <all_urls> and V2 permissions-array host patterns too", () => {
    const v2 = JSON.stringify({ manifest_version: 2, permissions: ["<all_urls>", "cookies"] });
    const combos = findOverbroadCombos("m.json", v2);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.broadHost).toBe("<all_urls>");
  });

  it("stays silent on broad hosts WITHOUT a sensitive capability (a content-script-only extension)", () => {
    const m = JSON.stringify({ manifest_version: 3, permissions: ["storage"], host_permissions: ["https://*/*"] });
    expect(findOverbroadCombos("m.json", m)).toEqual([]);
  });

  it("ignores non-WebExtension manifest.json files (no manifest_version)", () => {
    expect(findOverbroadCombos("pwa/manifest.json", JSON.stringify({ name: "pwa", icons: [] }))).toEqual([]);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/ext-baseline-2000.txt")).toEqual(new Map());
  });
});
