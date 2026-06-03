// §17.3 — OAuth error page. The auth callback redirects here with
// ?message=<reason> when the provider returns an error or Supabase rejects
// the session exchange. Without this route those redirects 404.

import React from "react";

export default async function AuthErrorPage(props: {
  searchParams: Promise<Record<string, string>>;
}): Promise<React.ReactElement> {
  const searchParams = await props.searchParams;
  // `message` is URL-controllable; render it as escaped text only (never HTML)
  // and cap its length so a crafted link can't fill the page with arbitrary copy.
  const message = (searchParams.message ?? "").slice(0, 200);

  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-5 p-6">
      <h1 className="text-[22px] font-bold">Sign-in problem</h1>
      <p className="text-muted-foreground max-w-[420px] text-center">
        We couldn&apos;t complete your sign-in. Please try again — if it keeps happening, contact
        support.
      </p>
      {message && (
        <p className="text-muted-foreground/70 max-w-[420px] text-center text-[13px]">{message}</p>
      )}
      <a
        href="/signup"
        className="block w-[280px] px-4 py-3 border border-border rounded-lg bg-card text-center no-underline text-[14px] font-medium text-foreground hover:bg-accent transition-colors"
      >
        Back to sign in
      </a>
    </main>
  );
}
