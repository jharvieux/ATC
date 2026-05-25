#!/usr/bin/env tsx
// Prints the local Tier-2 / Tier-2.5 test JWTs to stdout as shell
// assignment lines, so callers can `eval` them into the current env.
//
// Use from CI:
//   eval "$(pnpm tsx scripts/print-test-jwts.ts)"
//
// Or for local .env.local:
//   pnpm tsx scripts/print-test-jwts.ts
//
// The tokens are signed at runtime with the literal secret in
// tests/security/_test-jwt-fixtures.ts (same module the unit tests import),
// so the JWT literals never appear in any committed file.

import {
  TEST_ANON_JWT,
  TEST_SERVICE_ROLE_JWT,
} from "../tests/security/_test-jwt-fixtures";

process.stdout.write(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${TEST_ANON_JWT}\n`);
process.stdout.write(`SUPABASE_SERVICE_ROLE_KEY=${TEST_SERVICE_ROLE_JWT}\n`);
