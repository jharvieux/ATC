// §25.5 — Sentry server config with PII-scrubbing beforeSend.

import * as Sentry from "@sentry/nextjs";
import { scrubPii } from "@/lib/sentry/pii-scrubber";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      return scrubPii(event);
    },
    beforeBreadcrumb(breadcrumb) {
      return scrubPii(breadcrumb);
    },
  });
}
