// §23.3 — Unsubscribe confirmation page.
// CAN-SPAM requires unsubscribe requests to be honored within 10 business days.
// The platform processes them immediately.

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function UnsubscribeConfirmedPage() {
  return (
    <main className="max-w-[500px] mx-auto mt-20 px-4 text-center">
      <h1 className="text-foreground text-2xl font-semibold">You&rsquo;ve been unsubscribed.</h1>
      <p className="text-muted-foreground leading-[1.7] mt-3">
        Your unsubscribe request has been processed. You won&rsquo;t receive further emails
        of that type from this agency.
      </p>
      <p className="text-muted-foreground text-[14px] mt-2">
        You can manage your email preferences at any time from your account settings.
      </p>
      <div className="mt-6">
        <Button asChild>
          <Link href="/">Back to home</Link>
        </Button>
      </div>
    </main>
  );
}
