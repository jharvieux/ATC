// Landing page. Two paths:
//   - Anonymous visitor → render the placeholder landing (Phase 3 will
//     give this a real hero + login button).
//   - Logged-in user → redirect to the post-login dispatcher destination
//     (their admin hub / next onboarding step / tenant home / chat),
//     because the placeholder was the "blank page after login" symptom.

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
