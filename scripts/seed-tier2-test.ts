// Tier-2 E2E test seed — minimal tenant + user for Playwright specs.
//
// Idempotent: safe to re-run. Looks up the byo_research tier (cheapest),
// creates a deterministic tenant + auth.users stub + public.users row,
// and prints the IDs the .env.local needs.
//
// Usage:
//   SUPABASE_DB_URL=postgresql://$USER@localhost:5432/atc_main_test \
//     pnpm tsx scripts/seed-tier2-test.ts

import postgres from "postgres";

const TENANT_ID = "22222222-0000-0000-0000-0000000000a1";
const AUTH_USER_ID = "a0000000-0000-0000-0000-0000000000a1";
const PUBLIC_USER_ID = "b0000000-0000-0000-0000-0000000000b1";

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error("SUPABASE_DB_URL must be set (postgresql://$USER@localhost:5432/atc_main_test).");
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, idle_timeout: 10, onnotice: () => {} });

  try {
    // 1. Look up an existing tier so the FK is satisfied without us
    //    knowing the migration-generated UUID up-front.
    const tiers = await sql<Array<{ id: string }>>`
      SELECT id FROM public.tier_definitions WHERE code = 'byo_research' LIMIT 1
    `;
    if (tiers.length === 0) {
      throw new Error("No byo_research tier found — run migrations first.");
    }
    const tierId = tiers[0]!.id;

    // 2. Tenant.
    await sql`
      INSERT INTO public.tenants (
        id, slug, display_name, legal_name, tenant_type, status,
        tier_id, seat_count, billing_period, ai_mode
      ) VALUES (
        ${TENANT_ID}, 'e2e-test', 'E2E Test Tenant', 'E2E Test Tenant LLC',
        'byo_host', 'active',
        ${tierId}, 1, 'monthly', 'autonomous'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // 3. auth.users stub row (created by scripts/local-pg-bootstrap.sql).
    await sql`
      INSERT INTO auth.users (id, email, role)
      VALUES (${AUTH_USER_ID}, 'e2e-test@local', 'authenticated')
      ON CONFLICT (id) DO NOTHING
    `;

    // 4. public.users tied to tenant.
    await sql`
      INSERT INTO public.users (id, auth_user_id, tenant_id, email, first_name, last_name, status)
      VALUES (
        ${PUBLIC_USER_ID}, ${AUTH_USER_ID}, ${TENANT_ID},
        'e2e-test@local', 'E2E', 'Tester', 'active'
      )
      ON CONFLICT (id) DO NOTHING
    `;

    console.log("✓ Tier-2 test fixtures seeded.");
    console.log("");
    console.log("Add these to apps/main/.env.local:");
    console.log("  TEST_AUTH_BYPASS_TOKEN=tier2-local-test-secret");
    console.log(`  TEST_AUTH_BYPASS_TENANT_ID=${TENANT_ID}`);
    console.log(`  TEST_AUTH_BYPASS_USER_ID=${AUTH_USER_ID}`);
    console.log("");
    console.log("Public user row id (for fixtures that need it):");
    console.log(`  ${PUBLIC_USER_ID}`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
