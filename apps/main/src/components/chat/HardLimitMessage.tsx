// §24.9 — Hard-limit system message rendered when the customer hits the cap.
// NOT in-character — clearly platform-spoken.

import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format-date";

export function HardLimitMessage({
  body,
  resetAt,
}: {
  body: string;
  resetAt: string;
}): JSX.Element {
  const resetPretty = formatDate(resetAt);
  return (
    <div
      role="alert"
      className="m-4 p-5 bg-amber-50 dark:bg-amber-950/20 border border-amber-400 dark:border-amber-600 rounded-lg text-amber-900 dark:text-amber-200"
    >
      <p className="mb-2 font-bold">Chat limit reached</p>
      <p className="mb-3 whitespace-pre-wrap">{body}</p>
      <p className="mb-4 text-[13px]">Quota resets {resetPretty}.</p>
      <div className="flex gap-2.5">
        <Button asChild>
          <a href="/api/chat/escalate">Talk to a human</a>
        </Button>
        <Button asChild variant="outline">
          <a href="/bookings">View my bookings</a>
        </Button>
      </div>
    </div>
  );
}
