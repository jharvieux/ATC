// #1636 — unit tests for the lifecycle-script supply-chain guard.
//
// The load-bearing property: keys are content-hash based (version-independent),
// so a same-hook version bump collapses to one key while a changed hook yields a
// different key. That's what keeps the guard low-churn but able to catch a
// Shai-Hulud-style script swap.

import { describe, it, expect } from "vitest";
import { hooksFromManifest } from "../../../scripts/check-lifecycle-scripts";

describe("hooksFromManifest", () => {
  it("extracts preinstall/install/postinstall/prepare hooks", () => {
    const hooks = hooksFromManifest({
      name: "evil-pkg",
      scripts: { postinstall: "node steal.js", build: "tsc" },
    });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ name: "evil-pkg", script: "postinstall", content: "node steal.js" });
  });

  it("returns nothing for a package with no lifecycle hooks", () => {
    expect(hooksFromManifest({ name: "safe", scripts: { build: "tsc", test: "vitest" } })).toEqual([]);
  });

  it("ignores manifests with no name or no scripts", () => {
    expect(hooksFromManifest({ scripts: { postinstall: "x" } })).toEqual([]);
    expect(hooksFromManifest({ name: "x" })).toEqual([]);
  });

  it("keys are version-independent but content-sensitive", () => {
    const a = hooksFromManifest({ name: "p", scripts: { postinstall: "node a.js" } })[0];
    const b = hooksFromManifest({ name: "p", scripts: { postinstall: "node a.js" } })[0];
    const c = hooksFromManifest({ name: "p", scripts: { postinstall: "node EVIL.js" } })[0];
    expect(a.key).toBe(b.key); // same content → same key (a bump won't churn)
    expect(a.key).not.toBe(c.key); // changed content → new key (caught)
  });

  it("skips empty/whitespace script bodies", () => {
    expect(hooksFromManifest({ name: "p", scripts: { postinstall: "   " } })).toEqual([]);
  });
});
