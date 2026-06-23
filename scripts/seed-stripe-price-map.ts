// EPIC #1336, Phase 2 (#1338) — Seed public.stripe_price_map from the
// STRIPE_PRICE_* env vars. A SQL migration can't read env secrets, so this is
// the runtime "seed" step. Idempotent: ON CONFLICT updates the price ID +
// updated_at, so re-running just reconciles the table to the current env.
//
// amount_cents is NOT set here — the live Stripe unit_amount is populated by the
// Phase 3 pricing editor (#1339), which already talks to Stripe. The column is
// nullable; checkout/billing only need the price ID.
//
// ⚠️ DB targeting (D-285): this writes to whichever DB the chosen URL points at.
//   --target=test → SUPABASE_TEST_DB_URL  (the test/staging DB)
//   --target=prod → SUPABASE_DB_URL       (PRODUCTION)
// The env you read STRIPE_PRICE_* from MUST match the Stripe mode of that DB
// (test-mode price IDs → test DB; live-mode price IDs → prod DB). Pull the right
// env first (e.g. `vercel env pull` for prod) before pointing at prod.
//
// Usage (dry-run prints what it would upsert and exits without writing):
//   tsx scripts/seed-stripe-price-map.ts --target=test
//   tsx scripts/seed-stripe-price-map.ts --target=test --apply
//   tsx scripts/seed-stripe-price-map.ts --target=prod --apply

import postgres from "postgres";
import { PRICE_ID_ENV_MAP } from "../apps/main/src/lib/stripe/price-id-map";

type Target = "test" | "prod";

function parseTarget(argv: string[]): Target {
  const arg = argv.find((a) => a.startsWith("--target="));
  const value = arg?.slice("--target=".length);
  if (value !== "test" && value !== "prod") {
    throw new Error("--target must be 'test' or 'prod'");
  }
  return value;
}

function resolveDbUrl(target: Target): string {
  const envVar = target === "prod" ? "SUPABASE_DB_URL" : "SUPABASE_TEST_DB_URL";
  const url = process.env[envVar];
  if (!url) throw new Error(`${envVar} must be set to a direct Postgres connection URL.`);
  return url;
}

interface SeedRow {
  tenant_type: string;
  tier: string;
  billing_period: string;
  line_item: string;
  stripe_price_id: string;
}

function collectRows(): { rows: SeedRow[]; missing: string[] } {
  const rows: SeedRow[] = [];
  const missing: string[] = [];
  for (const [key, envVar] of Object.entries(PRICE_ID_ENV_MAP)) {
    const priceId = process.env[envVar];
    if (!priceId) {
      missing.push(`${key} (${envVar})`);
      continue;
    }
    const [tenant_type, tier, billing_period, line_item] = key.split(".");
    rows.push({ tenant_type, tier, billing_period, line_item, stripe_price_id: priceId });
  }
  return { rows, missing };
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv);
  const apply = process.argv.includes("--apply");
  const dbUrl = resolveDbUrl(target);
  const host = new URL(dbUrl).host;

  const { rows, missing } = collectRows();

  console.error(`Target: ${target} (${host})`);
  console.error(`Mode:   ${apply ? "APPLY (will write)" : "DRY-RUN (no writes)"}`);
  console.error(`Found ${rows.length}/${Object.keys(PRICE_ID_ENV_MAP).length} price IDs in env.`);
  for (const r of rows) {
    console.error(`  ${r.tenant_type}.${r.tier}.${r.billing_period}.${r.line_item} → ${r.stripe_price_id}`);
  }
  if (missing.length > 0) {
    console.error(`Skipping ${missing.length} unset env var(s) (env fallback still covers these):`);
    for (const m of missing) console.error(`  - ${m}`);
  }

  if (!apply) {
    console.error("\nDry-run complete. Re-run with --apply to write.");
    return;
  }
  if (rows.length === 0) {
    console.error("\nNothing to write (no price IDs in env).");
    return;
  }

  const sql = postgres(dbUrl, { max: 1, idle_timeout: 10 });
  try {
    const result = await sql`
      INSERT INTO public.stripe_price_map ${sql(rows, "tenant_type", "tier", "billing_period", "line_item", "stripe_price_id")}
      ON CONFLICT (tenant_type, tier, billing_period, line_item)
      DO UPDATE SET stripe_price_id = EXCLUDED.stripe_price_id, updated_at = NOW()
    `;
    console.error(`\nUpserted ${result.count} row(s) into stripe_price_map.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
