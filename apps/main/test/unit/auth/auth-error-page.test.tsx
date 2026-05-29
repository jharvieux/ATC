// §17.3 — /auth/error render contract.
//
// The page reflects a URL-controllable `?message=` param. Two security
// contracts must hold: the message is rendered as escaped text (never HTML),
// and it is length-capped so a crafted link can't fill the page with arbitrary
// copy. React's default escaping gives the first; this test fails the day a
// future edit switches to dangerouslySetInnerHTML or drops the slice.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AuthErrorPage from "../../../src/app/auth/error/page";

async function render(message: string): Promise<string> {
  const el = await AuthErrorPage({ searchParams: Promise.resolve({ message }) });
  return renderToStaticMarkup(el);
}

describe("/auth/error page", () => {
  it("escapes a reflected message so the URL can't inject HTML", async () => {
    const out = await render("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("caps the reflected message at 200 characters", async () => {
    const out = await render("A".repeat(500));
    expect(out).toContain("A".repeat(200));
    expect(out).not.toContain("A".repeat(201));
  });
});
