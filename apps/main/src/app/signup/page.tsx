// §17.3 — Signup landing page.
// Two paths: customer signup ("I'm booking travel") and tenant signup
// ("I'm setting up my agency"). Each triggers the appropriate Supabase OAuth
// flow with the correct redirect_to for post-OAuth routing.

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/branding/Logo";

export default function SignupPage(): React.ReactElement {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-8 p-4">
      <Logo height={84} />
      <h1 className="text-3xl font-bold">Create your account</h1>
      <div className="flex gap-6 flex-wrap justify-center">
        <SignupCard
          title="I'm booking travel"
          description="Sign up as a traveler to get AI-powered cruise planning."
          redirectTo="/auth/callback?flow=customer"
        />
        <SignupCard
          title="I'm setting up my agency"
          description="Sign up to deploy AI Travel Concierge for your clients."
          redirectTo="/signup/complete"
        />
      </div>
    </main>
  );
}

function SignupCard(props: { title: string; description: string; redirectTo: string }): React.ReactElement {
  return (
    <Card className="w-72 text-center">
      <form method="GET" action="/api/auth/oauth-initiate">
        <input type="hidden" name="redirect_to" value={props.redirectTo} />
        <CardHeader>
          <CardTitle className="text-lg">{props.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground mb-2">{props.description}</p>
          <OAuthButton provider="google" label="Continue with Google" />
          <OAuthButton provider="azure" label="Continue with Microsoft" />
          <OAuthButton provider="facebook" label="Continue with Facebook" />
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
