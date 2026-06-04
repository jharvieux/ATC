// Dispatch lives here (not in /api/auth/callback) so post-login routing
// has a single source of truth — adding it to the callback would mean
// keeping two redirect tables in sync. See resolve-post-login.ts.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Logo } from "@/components/branding/Logo";
import { resolvePostLoginDestination } from "@/lib/auth/resolve-post-login";

export default async function HomePage() {
  const incoming = await headers();
  const forwarded = new Headers();
  const cookie = incoming.get("cookie");
  if (cookie) forwarded.set("cookie", cookie);
  const auth = incoming.get("authorization");
  if (auth) forwarded.set("authorization", auth);

  const dest = await resolvePostLoginDestination(
    new Request("https://placeholder.internal/", { headers: forwarded }),
  );
  if (dest) redirect(dest);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6">
      <Logo height={56} />
      <p className="text-muted-foreground">AI Travel Concierge</p>
    </main>
  );
}
