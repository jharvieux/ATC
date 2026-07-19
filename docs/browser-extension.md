# ATC Knowledge Base Clipper — Browser Extension

Chrome extension that lets you right-click any selected text on a cruise or travel supplier website and save it directly to your ATC knowledge base.

---

## How to install (unpacked, developer mode)

The extension is not yet published to the Chrome Web Store. Until it is, install it as an unpacked extension:

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `apps/extension` folder from this repository
5. The **ATC Knowledge Clipper** icon will appear in your extensions bar

> **Pinning**: right-click the puzzle-piece icon → select ATC Knowledge Clipper → choose **Pin**.

---

## First-time connection

The extension connects to the platform using your existing browser session — no separate login is required. It reads the session your browser already has from signing into the platform with Google, Microsoft, or Facebook.

1. Click the **ATC Knowledge Clipper** icon in your toolbar
2. Enter your **Platform URL**, e.g. `https://yourteam.atcplatform.com`
3. Click **Connect**
4. Chrome will prompt you to allow the extension to read data on that one platform URL — click **Allow**. The extension only ever requests this for the specific platform origin you connect to, never for every site you visit.

**If you are already signed into the platform in this browser**, the extension connects immediately — no further steps needed.

**If you are not yet signed in**, the extension will show a "Sign in required" screen:

1. Click **Open platform to sign in**
2. The platform opens in a new tab — sign in with Google, Microsoft, or Facebook as normal
3. Return to the extension popup and click **I've signed in — connect**

Your session is stored in the extension's local storage and refreshed automatically. You only need to connect once per browser profile.

> **Auto-detection**: if the platform URL is already saved from a previous connection, or if you currently have a platform tab open, the extension will pre-fill the URL automatically.

---

## Clipping content

1. Browse to any cruise line, tour operator, or supplier website
2. **Select** the text you want to save (a paragraph, a pricing table, key specs)
3. **Right-click** the selection and choose **Add to ATC Knowledge Base**
4. A small popup opens showing the captured text, source URL, and page title
5. Review the content — you can edit it before submitting
6. Click **Submit to Knowledge Base**
7. The content lands in your tenant's **Knowledge Review Queue** (`/knowledge/review`), where you can approve, edit, or reject it before it enters the active knowledge base

---

## How authentication works

The extension reads the Supabase session cookie set by the platform after you sign in with your OAuth provider (Google, Microsoft, or Facebook). The extension never handles credentials. When the access token is close to expiry, it is refreshed automatically using your Supabase refresh token. If the refresh fails (e.g. after a sign-out on the platform), you will see "Sign in required" and can reconnect in one click.

API calls use `Authorization: Bearer <token>` — the session cookie is only read locally for the token value and is never sent across origins.

The extension does not hold standing cookie access to every site. It requests permission for a single origin (the platform URL you connect to) via Chrome's optional-permissions prompt at connect time. `optional_host_permissions` in `manifest.json` still lists `https://*/*` (Chrome requires the broad pattern to be declared up front so it can be requested piecemeal at runtime) — the actual protection is that any such request surfaces a user-visible Chrome permission prompt naming the exact origin, not that the extension is architecturally incapable of asking for more.

### Trust boundary: Supabase auth fetches

Token-refresh calls (`popup.js`, `submit.js`) hit `<supabase_url>/auth/v1/token` directly, and that origin is never covered by `ensureHostPermission` — only the tenant platform origin is requested. This works because Supabase's GoTrue auth server's CORS handler (`supabase/auth`, `internal/api/api.go`) allows all origins by default (its `cors.Options` doesn't set `AllowedOrigins`, and the underlying `rs/cors` library treats that as allow-all), since GoTrue is designed to be called from arbitrary browser origins — the anon key plus JWT verification is the real authorization boundary, not CORS. If the platform ever fronts Supabase Auth with a custom CORS policy that restricts origins, this refresh path would need the Supabase origin added to the `ensureHostPermission` request (combined into the same user gesture as the tenant-origin request, since a second silent `chrome.permissions.request` outside a gesture throws).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach that platform URL" | Check the URL — it must include `https://` and match your tenant subdomain exactly |
| "Sign in required" after entering URL | Open the platform in a tab, sign in, then click "I've signed in — connect" |
| "Session expired" in submit popup | Open the extension popup and reconnect |
| Submit popup appears blank | The pending capture may have expired; right-click and select again |
| 403 Forbidden | Your account may not have the `rag_submissions: create` permission — contact your tenant admin |
| Extension icon not visible | Go to `chrome://extensions`, confirm ATC Clipper is enabled, and pin it from the toolbar |

---

## Publishing to the Chrome Web Store (future)

When the platform is ready for public release, the extension should be submitted to the [Chrome Web Store](https://chrome.google.com/webstore/devconsole) under the platform's developer account. Key steps:

1. Create a 128×128 icon and 440×280 promotional tile
2. Update `manifest.json` version number
3. Zip the `apps/extension/` folder
4. Upload at the Developer Dashboard → New Item

Until then, the unpacked install approach above works for all tenant admins with access to this repository.
