/**
 * BP30 §30.4 — integration-test database helpers.
 *
 * Lifts the per-test boilerplate of "stand up a clean DB, run migrations,
 * load fixtures, run the test, tear down" into three named functions.
 * Lives under apps/main/src/test/ so it's importable from the same `@/`
 * alias the production code uses.
 *
 * Default backend: testcontainers (ephemeral Postgres per run) — see the
 * BP30 Phase A → Phase B scope decision (MEMORY D-063 / D-064). The
 * alternative was a dedicated long-lived test Supabase project, deferred
 * for cost.
 *
 * IMPORTANT: this module is a SCAFFOLD. testcontainers is NOT yet listed
 * as a workspace dependency; adding it is operator opt-in (Docker must be
 * available on the developer machine + CI runner). The helpers therefore
 * throw a structured error if `withTestDatabase` is called without
 * testcontainers installed — guiding the operator to install it when they
 * first want to write an integration test.
 *
 * When the first integration test lands:
 *   1. Add `testcontainers` to the root devDependencies.
 *   2. Replace the throw at the top of `_acquireContainer` with the real
 *      `new GenericContainer("postgres:16-alpine")...start()` chain.
 *   3. Update CI to ensure Docker is available on the runner.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface TestDatabase {
  /** Connection string for the freshly-set-up database. */
  url: string;
  /** Shut the container down + free the port. */
  cleanup: () => Promise<void>;
}

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const FIXTURES_DIR = join(REPO_ROOT, "test-data", "fixtures");
const MIGRATIONS_DIR = join(REPO_ROOT, "apps", "main", "supabase", "migrations");

/**
 * Acquire a clean Postgres test database. Today this throws until the
 * operator opts into testcontainers; see the module header.
 */
async function _acquireContainer(): Promise<TestDatabase> {
  throw new Error(
    "[db-setup] testcontainers is not yet installed in this workspace. " +
      "To enable integration tests: " +
      "(1) `pnpm add -wD testcontainers`, " +
      "(2) replace the throw in apps/main/src/test/db-setup.ts → _acquireContainer with a real container.start() call, " +
      "(3) ensure Docker is available on the CI runner. " +
      "Until then, integration tests should be skipped (it.skipIf(!process.env.INTEGRATION_DB))."
  );
}

/**
 * Run every migration in apps/main/supabase/migrations/ against `url`,
 * in lexicographic (== chronological per our naming convention) order.
 *
 * Uses `psql` directly via spawnSync so we don't pull in a migration
 * library just for tests. Skips files that don't end in `.sql`.
 */
export function runMigrations(url: string): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", join(MIGRATIONS_DIR, f)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `[db-setup] migration ${f} failed (exit ${result.status}): ${result.stderr?.toString()}`,
      );
    }
  }
}

/**
 * Apply every test-data/fixtures/*.sql file in order. Uses the same psql
 * spawn shape as `runMigrations` so the two paths share a single
 * dependency surface (only psql).
 *
 * Header-only stub fixtures (no INSERT/UPDATE/DELETE/WITH/SELECT) are
 * silently skipped — matches the loader CLI behavior.
 */
export function loadFixtures(url: string): void {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const path = join(FIXTURES_DIR, f);
    const sql = readFileSync(path, "utf8");
    if (!/^\s*(?:INSERT|UPDATE|DELETE|WITH|SELECT)\s/im.test(sql)) {
      continue; // header-only stub
    }
    const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-f", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `[db-setup] fixture ${f} failed (exit ${result.status}): ${result.stderr?.toString()}`,
      );
    }
  }
}

/**
 * Set up a fresh test database: container, migrations, fixtures.
 * Returns the connection string + cleanup callback.
 *
 * Until testcontainers is wired (see module header) this throws — call
 * sites must guard with `it.skipIf(!process.env.INTEGRATION_DB)`.
 */
export async function setupTestDatabase(): Promise<TestDatabase> {
  const db = await _acquireContainer();
  runMigrations(db.url);
  loadFixtures(db.url);
  return db;
}

/**
 * Drop the test database. With testcontainers this stops + removes the
 * container, freeing the port. A long-lived test Supabase project would
 * instead truncate every table here.
 */
export async function cleanupTestDatabase(db: TestDatabase): Promise<void> {
  await db.cleanup();
}

/**
 * Convenience wrapper: set up, run the test, tear down — even on throw.
 * Use this from individual `it()` blocks; it sequences the lifecycle
 * correctly so a failing test still releases the container.
 *
 * Example:
 *   it.skipIf(!process.env.INTEGRATION_DB)(
 *     "tenant A cannot see tenant B's bookings",
 *     () => withTestDatabase(async (db) => { ... }),
 *   );
 */
export async function withTestDatabase<T>(
  fn: (db: TestDatabase) => Promise<T>,
): Promise<T> {
  const db = await setupTestDatabase();
  try {
    return await fn(db);
  } finally {
    await cleanupTestDatabase(db);
  }
}
