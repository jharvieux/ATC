// Canonical public origin for building absolute URLs the browser will be sent
// to — Stripe Checkout success/cancel URLs and Connect account-link
// refresh/return URLs.
//
// Before this helper the three Stripe redirect routes each derived the origin
// differently (subscription/checkout used NEXT_PUBLIC_APP_URL; connect/link and
// tax-form/stripe-link used PLATFORM_PRIMARY_DOMAIN) and ALL fell back to a
// hardcoded localhost string when their var was unset. A localhost fallback in
// production is fail-open: Stripe redirects the user to a dead URL after they
// pay, with no error anywhere. Failing loud lets the operator fix the env var.
//
// Precedence: NEXT_PUBLIC_APP_URL is the app's public origin and is the correct
// target for a browser redirect; PLATFORM_PRIMARY_DOMAIN (required at boot) is
// the fallback. In a booted deployment at least one is always present, so the
// throw is an invariant guard, not an expected path.
export function platformBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const domain = process.env.PLATFORM_PRIMARY_DOMAIN;
  if (domain) return `https://${domain.replace(/\/+$/, "")}`;

  throw new Error(
    "platformBaseUrl: neither NEXT_PUBLIC_APP_URL nor PLATFORM_PRIMARY_DOMAIN is set — " +
      "cannot build an absolute redirect URL.",
  );
}
