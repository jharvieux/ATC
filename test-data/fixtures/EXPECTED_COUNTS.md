# Expected fixture row counts

The loader CLI (`scripts/load-fixtures.ts`) reads this file, applies each SQL
fixture in order, then asserts the row counts match.

Format: one line per table, `tablename: <expected_count>`.

Lines starting with `#` are comments. The `(TODO)` marker on a line means
the fixture is intentionally a stub today; the loader skips the count
assertion for those tables (treats them as informational).

## Currently populated

```
tier_definitions: 6
tenants: 5
legal_documents: 8
```

## TODO — populate when integration tests demand specific shapes

```
users: 0 (TODO)
contacts: 0 (TODO)
bookings: 0 (TODO)
commissions: 0 (TODO)
quotes: 0 (TODO)
rag_chunks: 0 (TODO)             # in the RAG project, not main
groups: 0 (TODO)
group_invitations: 0 (TODO)
forum_threads: 0 (TODO)
forum_messages: 0 (TODO)
```

## Why so many TODOs?

Per the BP30 Phase B scope decision (MEMORY D-064):

- The fixtures are infrastructure for FUTURE integration tests. The 605
  tests passing today use mocks and inline data — nothing currently
  consumes these fixtures.
- Several tables (`users`, `contacts`, `bookings`, ...) require seeding
  `auth.users` first, which is owned by Supabase Auth and best done via
  `supabase.auth.admin.createUser()` from the per-test setup helper
  rather than raw SQL. The db-setup helper at
  `apps/main/src/test/db-setup.ts` is the home for those.
- Skeletal-now / grow-later avoids the maintenance treadmill of keeping
  exhaustive fixtures in sync with 45 active migrations.

Grow the populated set when the first integration test needs a specific
shape — at that point add the rows and update the count here.
