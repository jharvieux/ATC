// Help-doc screenshot capture. Reads scripts/help-screenshots/manifest.ts,
// signs in once, and regenerates apps/main/public/help/<doc>/<id>.png for
// every (selected) entry. See docs/runbooks/help-docs.md.
//
// Usage:
//   pnpm help:screenshots                 # all shots
//   pnpm help:screenshots -- --doc branding
//   pnpm help:screenshots -- --id logo-fields
//   pnpm help:screenshots -- --no-auth    # public pages only
//
// Env (required unless --no-auth):
//   HELP_SHOTS_BASE_URL   tenant origin to capture against
//                         (the demo tenant subdomain — see runbook)
//   HELP_SHOTS_EMAIL      demo-tenant owner login
//   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
//   SUPABASE_SERVICE_ROLE_KEY   preferred session mint (see below)
//   HELP_SHOTS_PASSWORD         fallback mint via password grant
//
// Session mint: the beta Supabase project has email/password logins
// DISABLED (the product is OAuth-only), so the primary path mints a session
// via the GoTrue admin API (generate_link type=magiclink → /verify), which
// works regardless of the email-provider toggle but needs the service-role
// key. Password grant is kept as a fallback for environments where email
// auth is enabled (e.g. local). The resulting session JSON is injected as
// the sb-<ref>-auth-token cookie — same pattern as tests/e2e/global-setup.ts
// (duplicated rather than imported: this script must not depend on Playwright
// test fixtures or test env conventions).

import { chromium, errors as playwrightErrors, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { rejectWrongStateRender, LOGIN_CTA_NAME, INACTIVE_SITE_TEXT } from "./render-guard";
import * as fs from "node:fs";
import * as path from "node:path";
import { SHOTS, VIEWPORT, DEVICE_SCALE_FACTOR, type Shot, type ShotAnnotation } from "./manifest";

const OUT_ROOT = path.join(process.cwd(), "apps", "main", "public", "help");
const CLIP_PADDING = 16;

function parseArgs(): { doc?: string; id?: string; noAuth: boolean } {
  const args = process.argv.slice(2);
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return { doc: val("--doc"), id: val("--id"), noAuth: args.includes("--no-auth") };
}

async function mintSession(): Promise<unknown> {
  const email = process.env["HELP_SHOTS_EMAIL"];
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"];
  const anonKey = process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"];
  const serviceRoleKey = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  const password = process.env["HELP_SHOTS_PASSWORD"];
  if (!email || !supabaseUrl || !anonKey || (!serviceRoleKey && !password)) {
    throw new Error(
      "help-screenshots: set HELP_SHOTS_EMAIL, NEXT_PUBLIC_SUPABASE_URL, " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY or " +
        "HELP_SHOTS_PASSWORD (or pass --no-auth).",
    );
  }

  if (serviceRoleKey) {
    const linkResp = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", email }),
    });
    if (!linkResp.ok) {
      throw new Error(`help-screenshots: generate_link failed (${linkResp.status}): ${await linkResp.text()}`);
    }
    const { hashed_token } = (await linkResp.json()) as { hashed_token?: string };
    if (!hashed_token) throw new Error("help-screenshots: generate_link returned no hashed_token");

    const verifyResp = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash: hashed_token }),
    });
    if (!verifyResp.ok) {
      throw new Error(`help-screenshots: verify failed (${verifyResp.status}): ${await verifyResp.text()}`);
    }
    return verifyResp.json();
  }

  const resp = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    throw new Error(`help-screenshots: GoTrue sign-in failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

async function signIn(context: BrowserContext, baseUrl: string): Promise<void> {
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"]!;
  const session = await mintSession();

  const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
  const parsed = new URL(baseUrl);
  await context.addCookies([
    {
      name: `sb-${projectRef}-auth-token`,
      value: JSON.stringify(session),
      domain: parsed.hostname,
      path: "/",
      httpOnly: true,
      secure: parsed.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

/**
 * Draw annotations as DOM overlays so they re-render identically on every
 * capture. Indigo matches the product's brand primary; annotations must be
 * recognizable as documentation markup, not UI.
 */
async function injectAnnotations(page: Page, annotations: ShotAnnotation[]): Promise<void> {
  for (const a of annotations) {
    await page.locator(a.selector).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.evaluate((anns: ShotAnnotation[]) => {
    const COLOR = "#4F46E5";
    for (const a of anns) {
      const el = document.querySelector(a.selector);
      if (!el) throw new Error(`annotation selector matched nothing: ${a.selector}`);
      const r = el.getBoundingClientRect();
      const layer = document.createElement("div");
      layer.setAttribute("data-help-annotation", "");
      layer.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;`;

      if (a.type === "box") {
        const box = document.createElement("div");
        box.style.cssText =
          `position:fixed;left:${r.left - 4}px;top:${r.top - 4}px;` +
          `width:${r.width + 8}px;height:${r.height + 8}px;` +
          `border:3px solid ${COLOR};border-radius:8px;` +
          `box-shadow:0 0 0 2px rgba(255,255,255,.85);`;
        layer.appendChild(box);
      } else {
        const badge = document.createElement("div");
        badge.textContent = String(a.n ?? "?");
        badge.style.cssText =
          `position:fixed;left:${r.left - 14}px;top:${r.top - 14}px;` +
          `width:28px;height:28px;border-radius:50%;background:${COLOR};` +
          `color:#fff;font:700 15px/28px Inter,system-ui,sans-serif;text-align:center;` +
          `box-shadow:0 1px 4px rgba(0,0,0,.35);`;
        layer.appendChild(badge);
      }

      if (a.label) {
        const tag = document.createElement("div");
        tag.textContent = a.label;
        tag.style.cssText =
          `position:fixed;left:${r.left - 4}px;top:${r.bottom + 10}px;` +
          `background:${COLOR};color:#fff;padding:2px 8px;border-radius:6px;` +
          `font:600 13px/20px Inter,system-ui,sans-serif;white-space:nowrap;` +
          `box-shadow:0 1px 4px rgba(0,0,0,.35);`;
        layer.appendChild(tag);
      }
      document.body.appendChild(layer);
    }
  }, annotations);
}

async function capture(browser: Browser, shot: Shot, baseUrl: string, auth: boolean): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    if (auth) await signIn(context, baseUrl);
    const page = await context.newPage();
    await page.goto(new URL(shot.path, baseUrl).toString(), { waitUntil: "networkidle" });

    // Wrong-state renders (rejected session, blocked path) must never be
    // screenshotted — see render-guard.ts for the signal catalog. waitFor
    // (not isVisible, whose timeout option Playwright ignores) gives
    // late-hydrating content a bounded window to appear; only its expected
    // absence-timeout is absorbed — any other failure fails the shot.
    if (auth) {
      const becameVisible = (locator: Locator, timeout: number): Promise<boolean> =>
        locator
          .waitFor({ state: "visible", timeout })
          .then(() => true)
          .catch((e: unknown) => {
            if (e instanceof playwrightErrors.TimeoutError) return false;
            throw e;
          });
      const loginCta = page
        .getByRole("link", { name: LOGIN_CTA_NAME })
        .or(page.getByRole("button", { name: LOGIN_CTA_NAME }))
        .first();
      const rejection = rejectWrongStateRender(
        {
          landedPath: new URL(page.url()).pathname,
          loginCtaVisible: await becameVisible(loginCta, 1_000),
          inactiveSitePageVisible: await becameVisible(page.getByText(INACTIVE_SITE_TEXT), 500),
        },
        new URL(shot.path, baseUrl).pathname,
      );
      if (rejection) throw new Error(rejection);
    }

    // The cookie-consent banner (/consent flow) overlays the lower third of
    // every first visit — screenshots must never ship with it. Dismiss with
    // the minimal choice; ignore if this page didn't show it.
    const consentDismiss = page.getByRole("button", { name: "Essential only" });
    if (await consentDismiss.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await consentDismiss.click();
      await consentDismiss.waitFor({ state: "hidden", timeout: 5_000 });
    }

    if (shot.prepare) await shot.prepare(page);
    if (shot.annotations?.length) await injectAnnotations(page, shot.annotations);

    const outDir = path.join(OUT_ROOT, shot.doc);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${shot.id}.png`);

    if (shot.clip) {
      const box = await page.locator(shot.clip).first().boundingBox();
      if (!box) throw new Error(`clip selector matched nothing: ${shot.clip}`);
      await page.screenshot({
        path: outPath,
        clip: {
          x: Math.max(0, box.x - CLIP_PADDING),
          y: Math.max(0, box.y - CLIP_PADDING),
          width: box.width + CLIP_PADDING * 2,
          height: box.height + CLIP_PADDING * 2,
        },
      });
    } else {
      await page.screenshot({ path: outPath, fullPage: shot.fullPage ?? false });
    }
    console.log(`✓ ${shot.doc}/${shot.id}.png`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const { doc, id, noAuth } = parseArgs();
  const baseUrl = process.env["HELP_SHOTS_BASE_URL"];
  if (!baseUrl) throw new Error("help-screenshots: set HELP_SHOTS_BASE_URL (demo-tenant origin).");

  const selected = SHOTS.filter((s) => (!doc || s.doc === doc) && (!id || s.id === id));
  if (selected.length === 0) {
    throw new Error(
      SHOTS.length === 0
        ? "help-screenshots: manifest is empty — add Shot entries to scripts/help-screenshots/manifest.ts."
        : `help-screenshots: no manifest entry matches --doc=${doc ?? "*"} --id=${id ?? "*"}.`,
    );
  }

  const browser = await chromium.launch();
  const failures: string[] = [];
  try {
    for (const shot of selected) {
      try {
        await capture(browser, shot, baseUrl, !noAuth);
      } catch (err) {
        failures.push(`${shot.doc}/${shot.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length}/${selected.length} shots FAILED:`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n${selected.length} screenshot(s) written under apps/main/public/help/.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
