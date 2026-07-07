// §17.3 — Signup landing page.
// Two paths: customer signup ("I'm booking travel") and tenant signup
// ("I'm setting up my agency"). Each triggers the appropriate Supabase OAuth
// flow with the correct redirect_to for post-OAuth routing.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/branding/Logo";
import { env } from "@/lib/env";

// Reading env() at render time makes this page eligible for static
// prerendering at build time, which fails in CI (build doesn't populate the
// full env schema — see verifyEnvAtBoot). Force dynamic (per-request) render
// so env() resolves against the running server's actual environment instead.
export const dynamic = "force-dynamic";

export default function SignupPage(): React.ReactElement {
  const e = env();

  // §28.15 / issue #1668 — SIGNUP_ENABLED gates new sign-ups platform-wide;
  // existing tenants/customers are unaffected (this page is signup-only).
  if (!e.SIGNUP_ENABLED) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen gap-6 p-4 text-center">
        <Logo height={84} />
        <h1 className="text-3xl font-bold">Sign-ups are currently closed</h1>
        <p className="text-muted-foreground max-w-[420px]">
          We&apos;re not accepting new accounts right now. Please check back later.
        </p>
      </main>
    );
  }

  // §28.9 / issue #1668 — a disabled provider's button must not render, not
  // just fail at oauth-initiate.
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-8 p-4">
      <Logo height={84} />
      <h1 className="text-3xl font-bold">Create your account</h1>
      <div className="flex gap-6 flex-wrap justify-center">
        <SignupCard
          title="I'm booking travel"
          description="Sign up as a traveler to get AI-powered cruise planning."
          redirectTo="/auth/callback?flow=customer"
          googleEnabled={e.OAUTH_GOOGLE_ENABLED}
          microsoftEnabled={e.OAUTH_MICROSOFT_ENABLED}
          facebookEnabled={e.OAUTH_FACEBOOK_ENABLED}
        />
        <SignupCard
          title="I'm setting up my agency"
          description="Sign up to deploy AI Travel Concierge for your clients."
          redirectTo="/signup/complete"
          googleEnabled={e.OAUTH_GOOGLE_ENABLED}
          microsoftEnabled={e.OAUTH_MICROSOFT_ENABLED}
          facebookEnabled={e.OAUTH_FACEBOOK_ENABLED}
        />
      </div>
    </main>
  );
}

function SignupCard(props: {
  title: string;
  description: string;
  redirectTo: string;
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  facebookEnabled: boolean;
}): React.ReactElement {
  return (
    <Card className="w-72 text-center">
      <form method="GET" action="/api/auth/oauth-initiate">
        <input type="hidden" name="redirect_to" value={props.redirectTo} />
        <CardHeader>
          <CardTitle className="text-lg">{props.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground mb-2">{props.description}</p>
          {props.googleEnabled && <OAuthButton provider="google" label="Continue with Google" />}
          {props.microsoftEnabled && <OAuthButton provider="azure" label="Continue with Microsoft" />}
          {props.facebookEnabled && <OAuthButton provider="facebook" label="Continue with Facebook" />}
        </CardContent>
      </form>
    </Card>
  );
}

function OAuthButton(props: { provider: string; label: string }): React.ReactElement {
  return (
    <Button type="submit" variant="outline" name="provider" value={props.provider} className="w-full">
      {props.label}
    </Button>
  );
}
