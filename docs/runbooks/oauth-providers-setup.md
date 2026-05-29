# Runbook: OAuth Sign-in Providers Setup (§28.9)

> **Status:** Manual operator step. Social sign-in is gated behind per-provider
> flags. This runbook captures the setup once so the next operator doesn't
> re-derive it. Tracker: issue #428 (punch-list P4).

## Overview

Social sign-in (Google / Microsoft / Facebook) is bridged through **Supabase
Auth**. The app never talks to the provider directly — it calls
`supabase.auth.signInWithOAuth` and lets Supabase own the token exchange.

Each provider you enable is configured in **two places**:

1. The provider's own console (to get a client ID + secret).
2. The Supabase Auth dashboard (paste those credentials, enable the provider).

…plus the per-provider env flag in Vercel.

### Provider support — read this first

The initiation route hardcodes the providers it will accept
(`apps/main/src/app/api/auth/oauth-initiate/route.ts`):

```
const ALLOWED_PROVIDERS = new Set(["google", "azure", "facebook"]);
```

- **Microsoft is `azure`** in Supabase's provider naming (and in this set) — not
  `microsoft`.
- **Apple is deferred in code** (§17.1). It is *not* in `ALLOWED_PROVIDERS`, and
  `OAUTH_APPLE_ENABLED` defaults `false`. Enabling Apple is **not** a
  dashboard-only change — it needs a code edit (add `"apple"` to
  `ALLOWED_PROVIDERS` and to the provider union type on the
  `signInWithOAuth` call) plus the Apple-side Services ID / signing-key work.
  Treat Apple as out of scope for this runbook until that code change lands.

---

## Prerequisites

- A Supabase project for the target environment (the same one the app's
  `NEXT_PUBLIC_SUPABASE_URL` points at).
- Operator access to the Supabase Dashboard (Authentication settings).
- Operator access to Vercel environment variables (to set the flags + redeploy).
- An account in each provider's developer console you intend to enable
  (Google Cloud, Azure/Entra, Meta for Developers).

---

## The redirect flow (so the two layers make sense)

1. Browser hits `GET /api/auth/oauth-initiate?provider=<google|azure|facebook>`.
2. The route calls `supabase.auth.signInWithOAuth` with
   `redirectTo = <origin>/api/auth/callback` and 302-redirects the browser to
   the provider's consent screen (via Supabase).
3. Provider → Supabase → app lands back at **`/api/auth/callback`**.

That means there are **two redirect URIs to register**, in two different places:

| Layer | Where to register it | Value |
|---|---|---|
| Provider console | The provider's OAuth app | `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback` |
| Supabase dashboard | Authentication → URL Configuration → Redirect URLs allow-list | `https://<your-domain>/api/auth/callback` (+ `http://localhost:3000/api/auth/callback` for dev) |

Miss the provider-side one and consent fails. Miss the Supabase allow-list one
and the final hop back into the app is rejected.

---

## Env flags

Set in Vercel (all environments) and `.env.local` for dev. **Defaults matter:**

| Flag | Schema default | Notes |
|---|---|---|
| `OAUTH_GOOGLE_ENABLED` | `true` | Button renders by default — configure Google or sign-in fails. |
| `OAUTH_MICROSOFT_ENABLED` | `true` | Default-on; also makes `MICROSOFT_GRAPH_CLIENT_ID` + `MICROSOFT_GRAPH_CLIENT_SECRET` **required at boot** (env superRefine). Set `false` locally to skip. |
| `OAUTH_FACEBOOK_ENABLED` | `true` | Button renders by default. |
| `OAUTH_APPLE_ENABLED` | `false` | Off, and deferred in code (see above). |

> Because three flags default **on**, a fresh production env renders the
> Google/Microsoft/Facebook buttons before any provider is configured —
> clicking them errors until each is set up in Supabase. Either complete the
> provider below, or set its flag `false` until you do.

---

## Google (standard flow — high confidence)

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs &
   Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URI:
   `https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback`.
4. Copy the **Client ID** and **Client Secret**.
5. Supabase Dashboard → **Authentication → Providers → Google** → paste both →
   **Enable**.
6. Supabase Dashboard → **Authentication → URL Configuration** → add
   `https://<your-domain>/api/auth/callback` (and the localhost variant) to the
   **Redirect URLs** allow-list.
7. `OAUTH_GOOGLE_ENABLED=true` in Vercel (all envs) → redeploy.

---

## Microsoft (`azure`) and Facebook

Same Supabase-side pattern as Google: **Authentication → Providers → \<provider\>
→ paste credentials → Enable**, then add the app redirect URL to the allow-list
and flip the flag. Only the provider-side console steps differ.

- **Microsoft (Azure / Entra):** register an app in the Azure Portal →
  **Certificates & secrets** for the client secret. These values also populate
  `MICROSOFT_GRAPH_CLIENT_ID` / `MICROSOFT_GRAPH_CLIENT_SECRET` (required at boot
  whenever `OAUTH_MICROSOFT_ENABLED=true`). In Supabase the provider is **Azure**.
- **Facebook:** create an app at [Meta for Developers](https://developers.facebook.com/),
  add **Facebook Login**, set the redirect URI to the Supabase callback above.

> **Confidence note:** the Google + Supabase redirect-URI flow above is the
> standard one and is reliable. The Microsoft and Facebook **console
> click-paths are version-specific** and their dashboards change often — follow
> the official guides below against the live dashboards rather than treating any
> exact click-path here as durable:
> - Supabase social login: <https://supabase.com/docs/guides/auth/social-login>
> - Azure app registration: Azure Portal → App registrations.

---

## Done when

Each **enabled** provider completes sign-in end-to-end (provider consent →
`/api/auth/callback` → authenticated session). Each **disabled** provider
renders no button on the sign-in screen.

---

## Disabling a provider

1. Set the provider's `OAUTH_*_ENABLED` flag to `false` in Vercel → redeploy
   (the button stops rendering).
2. Optionally disable the provider in Supabase → Authentication → Providers.
3. For Microsoft specifically: setting `OAUTH_MICROSOFT_ENABLED=false` also drops
   the boot requirement on `MICROSOFT_GRAPH_CLIENT_ID` / `_SECRET`.
