// §17.7 — Sensitive-operations re-auth page.
// Shown when a sensitive route detects a session older than 4 hours.
// Re-initiates the OAuth flow and returns to the original page.

import React from "react";

export default async function ReauthPage(props: { searchParams: Promise<Record<string, string>> }): Promise<React.ReactElement> {
  const searchParams = await props.searchParams;
  const returnTo = searchParams.return ?? "/";

  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-6">
      <h1 className="text-[22px] font-bold">Session expired</h1>
      <p className="text-muted-foreground max-w-[380px] text-center">
        For security, this action requires you to sign in again. You&apos;ll be returned to where you
        were after signing in.
      </p>
      <div className="flex flex-col gap-3 w-[280px]">
        <a
          href={`/api/auth/oauth-initiate?provider=google&redirect_to=${encodeURIComponent(returnTo)}`}
          className="block px-4 py-3 border border-border rounded-lg bg-card text-center no-underline text-[14px] font-medium text-foreground hover:bg-accent transition-colors"
        >
          Continue with Google
        </a>
        <a
          href={`/api/auth/oauth-initiate?provider=azure&redirect_to=${encodeURIComponent(returnTo)}`}
          className="block px-4 py-3 border border-border rounded-lg bg-card text-center no-underline text-[14px] font-medium text-foreground hover:bg-accent transition-colors"
        >
          Continue with Microsoft
        </a>
        <a
          href={`/api/auth/oauth-initiate?provider=facebook&redirect_to=${encodeURIComponent(returnTo)}`}
          className="block px-4 py-3 border border-border rounded-lg bg-card text-center no-underline text-[14px] font-medium text-foreground hover:bg-accent transition-colors"
        >
          Continue with Facebook
        </a>
      </div>
    </main>
  );
}
