// §17.2 Step 4 — no-email recovery: email-prompt page.
//
// Reached when an OAuth provider returns no email AND any provider-specific
// recovery (Microsoft Graph) also turns up nothing. Facebook with the email
// scope denied lands here too. The user types an email, receives a Resend
// verification code on the next step, and confirms ownership before their
// public.users row is created.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function EmailPromptPage(): React.ReactElement {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
      <h1 className="text-2xl font-bold">One more step</h1>
      <p className="text-muted-foreground text-sm max-w-sm text-center">
        Your sign-in provider didn&apos;t share an email address with us. Please
        enter your email so we can create your account and keep you updated on
        your bookings.
      </p>
      <EmailPromptForm />
    </main>
  );
}

function EmailPromptForm(): React.ReactElement {
  return (
    <form method="POST" action="/api/auth/microsoft-email-prompt" className="flex flex-col gap-4 w-80">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          name="email"
          required
          placeholder="you@example.com"
        />
      </div>
      <Button type="submit">Send verification code</Button>
    </form>
  );
}
