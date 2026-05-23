// §25.5 — Sentry client config with PII-scrubbing beforeSend.
//
// Operator extensions to the redaction list go in lib/sentry/pii-scrubber.ts.

import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "@/lib/sentry/pii-scrubber";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    beforeSend(event) {
      return scrubPii(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubPii(breadcrumb);
    },
  });
}
