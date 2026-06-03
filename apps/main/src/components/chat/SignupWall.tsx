// §24.8 — Signup wall when an anonymous identifier hits the limit.
// MUST NOT reveal which identifier hit.

import { Button } from "@/components/ui/button";

export function SignupWall({ body }: { body: string }): JSX.Element {
  return (
    <div
      role="alert"
      className="m-4 p-5 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg"
    >
      <p className="mb-3 text-blue-900 dark:text-blue-200 font-semibold">{body}</p>
      <Button asChild>
        <a href="/signup">Sign up to keep chatting</a>
      </Button>
    </div>
  );
}
