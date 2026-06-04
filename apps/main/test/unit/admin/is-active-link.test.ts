// Tests for the admin sidebar's active-link predicate. The reason this
// matters: drilling into a nested admin page must keep highlighting the
// parent ("you are here"). The slash-suffix guard prevents sibling
// false-positives. #668.

import { describe, it, expect } from "vitest";
import { isActiveLink } from "@/components/admin-shell/is-active-link";

describe("isActiveLink", () => {
  it("matches exact paths (the simple case)", () => {
    expect(isActiveLink("/admin/personas", "/admin/personas")).toBe(true);
  });

  it("matches a true descendant — nested detail page lights up its parent (#668's reason for existing)", () => {
    expect(
      isActiveLink("/admin/tenants/review-queue/abc-123", "/admin/tenants/review-queue"),
    ).toBe(true);
  });

  it("does NOT match a sibling whose path shares a prefix (the slash-guard)", () => {
    // Without the `+ "/"` guard, /admin/personas-legacy would light up
    // /admin/personas. This test fails the moment that guard is removed.
    expect(isActiveLink("/admin/personas-legacy", "/admin/personas")).toBe(false);
  });

  it("does NOT match unrelated paths", () => {
    expect(isActiveLink("/admin/help", "/admin/personas")).toBe(false);
  });

  it("returns false on null pathname (first render before usePathname resolves)", () => {
    expect(isActiveLink(null, "/admin/personas")).toBe(false);
  });
});
