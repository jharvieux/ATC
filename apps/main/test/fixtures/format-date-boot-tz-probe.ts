// Child-process probe for format-date.test.ts's "default path, ambient TZ"
// case. Must run as a separate process launched with TZ set at boot —
// reassigning process.env.TZ mid-process doesn't reliably invalidate V8's
// cached ICU timezone under vitest's worker_threads pool (see #1999).
import { formatDate } from "../../src/lib/format-date";

process.stdout.write(formatDate("2026-07-06T05:00:00Z", "numeric"));
