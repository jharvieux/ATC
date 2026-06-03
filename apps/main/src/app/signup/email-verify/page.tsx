// §17.2 Step 5 — no-email recovery: OTP entry.
//
// Reached from /api/auth/microsoft-email-prompt after the OTP has been mailed.
// The user types the 6-digit code; POST → /api/auth/microsoft-email-verify
// validates it, creates the public.users row, and lands them on "/".

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function EmailVerifyPage(): React.ReactElement {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
      <h1 className="text-2xl font-bold">Check your email</h1>
      <p className="text-muted-foreground text-sm max-w-sm text-center">
        We sent a 6-digit verification code to the address you provided. Enter
        it below to finish signing in.
      </p>
      <form
        method="POST"
        action="/api/auth/microsoft-email-verify"
        className="flex flex-col gap-4 w-80"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">Verification code</Label>
          <Input
            id="code"
            type="text"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            placeholder="123456"
            autoComplete="one-time-code"
            className="text-lg tracking-widest text-center h-12"
          />
        </div>
        <Button type="submit">Verify and continue</Button>
      </form>
    </main>
  );
}
