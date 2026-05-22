// §17.3 — Signup landing page.
// Two paths: customer signup ("I'm booking travel") and tenant signup
// ("I'm setting up my agency"). Each triggers the appropriate Supabase OAuth
// flow with the correct redirect_to for post-OAuth routing.

import { createClient } from "@supabase/supabase-js";

export default function SignupPage(): React.ReactElement {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  void supabaseUrl; void anonKey;

  return (
    <main style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", gap: 32, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Create your account</h1>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
        <SignupCard
          title="I'm booking travel"
          description="Sign up as a traveler to get AI-powered cruise planning."
          redirectTo="/auth/callback?flow=customer"
        />
        <SignupCard
          title="I'm setting up my agency"
          description="Sign up to deploy AI Travel Concierge for your clients."
          redirectTo="/auth/callback?flow=tenant"
        />
      </div>
    </main>
  );
}

function SignupCard(props: { title: string; description: string; redirectTo: string }): React.ReactElement {
  return (
    <form method="GET" action="/api/auth/oauth-initiate" style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 32, maxWidth: 300, textAlign: "center" }}>
      <input type="hidden" name="redirect_to" value={props.redirectTo} />
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>{props.title}</h2>
      <p style={{ color: "#6b7280", marginBottom: 24, fontSize: 14 }}>{props.description}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <OAuthButton provider="google" label="Continue with Google" />
        <OAuthButton provider="azure" label="Continue with Microsoft" />
        <OAuthButton provider="facebook" label="Continue with Facebook" />
      </div>
    </form>
  );
}

function OAuthButton(props: { provider: string; label: string }): React.ReactElement {
  return (
    <button
      name="provider"
      value={props.provider}
      style={{ padding: "10px 16px", border: "1px solid #d1d5db", borderRadius: 8, background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 500 }}
    >
      {props.label}
    </button>
  );
}
