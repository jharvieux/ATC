import { test, expect } from "@playwright/test";
import { BYPASS, HEADERS } from "./_helpers";

// #885 — AssetLightbox open-state browser test.
//
// The unit tests cover closed state + modal body in isolation, but
// DialogContent renders null while closed, so the interactive open/close
// cycle (click trigger → img loads, Esc / backdrop dismiss) requires a
// real browser. Tests here stub the /api/chat SSE stream to inject a
// known display_asset without touching the DB or running real AI.
//
// Acceptance criteria (§issue #885):
//  ✓ clicking "Norwegian Bliss Deck 17 ⤢" opens [role=dialog] with the asset img
//  ✓ the page does NOT navigate (URL unchanged, no new tab)
//  ✓ Esc closes the dialog
//  ✓ backdrop click closes the dialog

const ASSET_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_URL = "https://www.cruisemapper.com/images/deckplans/145471aaf27c508.gif";
const TRIGGER_LABEL = "Norwegian Bliss Deck 17 ⤢";

// Canned SSE stream: assets event → delta with the marker → done.
// The ChatExperience reader accumulates assets on the "assets" event and
// attaches them to the finalized message on "done".
function cannedSseBody(): string {
  const events = [
    {
      type: "assets",
      assets: [
        {
          asset_id: ASSET_ID,
          kind: "deck_plan",
          image_url: IMAGE_URL,
          source_page_url: "https://www.cruisemapper.com/deckplans/Norwegian-Bliss-1454",
          attribution: "Image: CruiseMapper",
          caption: "Norwegian Bliss Deck 17 - Cabins-The Haven Lower-Sundeck-Teens",
        },
      ],
    },
    { type: "delta", text: `Here is the deck plan: [[display_asset:${ASSET_ID}]]` },
    { type: "done" },
  ];
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

test.beforeEach(async ({ page }) => {
  // Suppress the CookieConsentBanner (role=dialog) so it doesn't pollute
  // [role=dialog] assertions. The banner opens when cookie_preferences is
  // absent; pre-setting it prevents the useEffect from calling setOpen(true).
  await page.context().addCookies([{
    name: "cookie_preferences",
    value: encodeURIComponent(JSON.stringify({ performance: true, marketing: false, set_at: "2026-01-01T00:00:00.000Z" })),
    domain: "localhost",
    path: "/",
    httpOnly: false,
    sameSite: "Lax",
  }]);

  // Inject the bypass Bearer on ALL requests (page navigations + API calls).
  // For page navigations this triggers the proxy's bypass branch, which sets
  // x-resolved-tenant-id: TENANT without ever reaching the platform-redirect
  // code that calls env().PLATFORM_PRIMARY_DOMAIN (unavailable in CI).
  // For API calls the full HEADERS set covers the auth + tenant headers.
  await page.route("**", async (route) => {
    const req = route.request();
    const isApi = req.url().includes("/api/");
    const headers = {
      ...req.headers(),
      ...(isApi ? HEADERS : { Authorization: `Bearer ${BYPASS}` }),
    };
    await route.continue({ headers });
  });

  // Stub the chat endpoint to return a deterministic SSE stream with the
  // asset. Only intercept POST; the beforeEach route above handles auth on
  // other API calls (news-ticker, etc.).
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: cannedSseBody(),
    });
  });
});

test("clicking the asset trigger opens the lightbox with the correct image", async ({ page }) => {
  await page.goto("/chat");

  // Submit any message — the stubbed API returns the asset regardless.
  await page.getByRole("textbox", { name: /message input/i }).fill("show me deck plans");
  await page.getByRole("button", { name: /send/i }).click();

  // Wait for the trigger button that the asset marker expands into.
  const trigger = page.getByRole("button", { name: TRIGGER_LABEL });
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole("dialog")).not.toBeVisible();

  await trigger.click();

  // Dialog appears with the asset image.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const img = dialog.locator("img");
  await expect(img).toHaveAttribute("src", IMAGE_URL);
});

test("opening the lightbox does not navigate away", async ({ page }) => {
  await page.goto("/chat");
  const initialUrl = page.url();

  await page.getByRole("textbox", { name: /message input/i }).fill("show me deck plans");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByRole("button", { name: TRIGGER_LABEL })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: TRIGGER_LABEL }).click();

  await expect(page.getByRole("dialog")).toBeVisible();
  expect(page.url()).toBe(initialUrl);
});

test("Esc closes the lightbox", async ({ page }) => {
  await page.goto("/chat");

  await page.getByRole("textbox", { name: /message input/i }).fill("show me deck plans");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByRole("button", { name: TRIGGER_LABEL })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: TRIGGER_LABEL }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("backdrop click closes the lightbox", async ({ page }) => {
  await page.goto("/chat");

  await page.getByRole("textbox", { name: /message input/i }).fill("show me deck plans");
  await page.getByRole("button", { name: /send/i }).click();

  await expect(page.getByRole("button", { name: TRIGGER_LABEL })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: TRIGGER_LABEL }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Click the top-left corner — outside the centered dialog panel, so it
  // lands on the backdrop overlay and triggers the outside-click close.
  await page.mouse.click(1, 1);

  await expect(dialog).not.toBeVisible();
});
