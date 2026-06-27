// Unit tests — dynamic-rendering detector (M9). Intent: flag page/layout files that
// opt into per-request dynamic SSR (cost), not arbitrary components.
import { describe, it, expect } from "vitest";
import { findDynamicOptIn } from "../../../scripts/check-dynamic-rendering";

const PAGE = "apps/main/src/app/dash/page.tsx";

describe("findDynamicOptIn", () => {
  it("flags a page reading searchParams", () => {
    expect(findDynamicOptIn(PAGE, `export default function P({searchParams}){return null}`)?.signals).toContain("searchParams");
  });

  it("flags headers()/cookies()/force-dynamic", () => {
    expect(findDynamicOptIn(PAGE, `import {headers} from 'next/headers'; headers()`)?.signals).toContain("headers()");
    expect(findDynamicOptIn(PAGE, `export const dynamic = 'force-dynamic'`)?.signals).toContain("dynamic='force-dynamic'");
  });

  it("returns null for a clean static page", () => {
    expect(findDynamicOptIn(PAGE, `export default function P(){return null}`)).toBeNull();
  });

  it("returns null for non-page files (a lib module using headers)", () => {
    expect(findDynamicOptIn("apps/main/src/lib/x.ts", `headers()`)).toBeNull();
  });
});
