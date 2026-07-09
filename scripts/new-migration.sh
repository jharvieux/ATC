#!/usr/bin/env bash
# Generate a new migration file with a real-clock, collision-resistant version.
#
# Usage: scripts/new-migration.sh <app: main|rag> <slug>
#   scripts/new-migration.sh main invitations_active_email_dedup
#   scripts/new-migration.sh rag  region_itinerary_origin_filter
#
# Why (#1660/#1661): the old convention derived a version deterministically
# ("day after the last migration" for main; "next sequential integer" for rag).
# N parallel agents reading the same dev snapshot all compute the SAME "next"
# value, so their migrations collide in the shared test DB's
# supabase_migrations.schema_migrations ledger — the first PR's CI run wins the
# ledger row, every sibling PR's `supabase db push` then fails. Real-clock
# second-resolution timestamps make same-machine collisions require the two
# agents to write within the same second; the atomic mkdir lock below closes
# even that window for agents sharing this machine's git-common-dir. Agents on
# different machines still have a small residual window — that's what
# scripts/check-migration-collision.ts (CI) backstops.
#
# Version format:
#   main: YYYYMMDDHHMMSS (14 digits, matches `supabase migration new`'s own
#         format, so it also sorts/compares correctly against existing
#         20260719000000-style versions).
#   rag:  YYYYMMDDHHMMSS_slug.sql too (folds RAG off its old bare `00NN_slug.sql`
#         sequential-integer convention, which has the identical collision
#         structure with no date component at all — see #1661).
#
# Locking: the reservation directory lives under the shared git-common-dir
# (`.git/migration-locks/<app>/<version>/`), NOT the worktree — every worktree
# and clone that shares this machine's .git sees the same lock directory, so
# concurrent agents in separate `git worktree` checkouts (as issue-sweep
# executors run) still serialize against each other. `mkdir` is atomic on a
# POSIX filesystem: exactly one concurrent caller wins the race for a given
# path. On EEXIST, sleep 1s and retry with a fresh timestamp (this also
# advances the clock past the collision).
#
# Version floor (#1717): dev's migration ledger contains hand-picked future
# dates (e.g. 20260722000000) alongside real-clock ones, so a pure wall-clock
# version can sort BEFORE the newest merged migration on a fresh DB apply. The
# version is therefore max(highest existing version in this app's migrations
# dir + 1 second, wall clock) — never behind the ledger, never behind "now".

set -euo pipefail

usage() {
  echo "Usage: scripts/new-migration.sh <app: main|rag> <slug>" >&2
  exit 1
}

APP="${1:-}"
SLUG="${2:-}"

if [[ "$APP" != "main" && "$APP" != "rag" ]]; then
  usage
fi
if [[ -z "$SLUG" ]]; then
  usage
fi
if ! [[ "$SLUG" =~ ^[a-z0-9_]+$ ]]; then
  echo "Slug must be lowercase alphanumeric + underscores (got: $SLUG)" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
LOCK_ROOT="$GIT_COMMON_DIR/migration-locks/$APP"
mkdir -p "$LOCK_ROOT"

MIGRATIONS_DIR="$REPO_ROOT/apps/$APP/supabase/migrations"
if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "Migrations dir not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

BRANCH="$(git branch --show-current 2>/dev/null || echo "(detached)")"
WORKTREE="$(basename "$REPO_ROOT")"

# Highest existing version in this app's migrations dir (numeric prefix before
# the first `_`). `10#` forces base-10 parsing so a leading-zero legacy RAG
# version like 0031 isn't misread as octal.
FLOOR=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f")"
  if [[ "$base" =~ ^([0-9]+)_ ]]; then
    v=$((10#${BASH_REMATCH[1]}))
    (( v > FLOOR )) && FLOOR=$v
  fi
done

MAX_ATTEMPTS=30
ATTEMPT=0
VERSION=""
LOCK_DIR=""

while (( ATTEMPT < MAX_ATTEMPTS )); do
  ATTEMPT=$((ATTEMPT + 1))
  WALL_CLOCK=$((10#$(TZ=UTC date +%Y%m%d%H%M%S)))
  MIN_NEXT=$((FLOOR + 1))
  if (( WALL_CLOCK > MIN_NEXT )); then
    CANDIDATE_NUM=$WALL_CLOCK
  else
    CANDIDATE_NUM=$MIN_NEXT
  fi
  CANDIDATE="$(printf '%014d' "$CANDIDATE_NUM")"
  CANDIDATE_LOCK="$LOCK_ROOT/$CANDIDATE"
  if mkdir "$CANDIDATE_LOCK" 2>/dev/null; then
    VERSION="$CANDIDATE"
    LOCK_DIR="$CANDIDATE_LOCK"
    break
  fi
  echo "Version $CANDIDATE already reserved on this machine — retrying in 1s (attempt $ATTEMPT/$MAX_ATTEMPTS)" >&2
  FLOOR=$CANDIDATE_NUM
  sleep 1
done

if [[ -z "$VERSION" ]]; then
  echo "Could not reserve a unique version after $MAX_ATTEMPTS attempts. Another process may be stuck holding a lock under $LOCK_ROOT." >&2
  exit 1
fi

ISO_TIMESTAMP="$(TZ=UTC date -u +%Y-%m-%dT%H:%M:%SZ)"
FILE="$MIGRATIONS_DIR/${VERSION}_${SLUG}.sql"

cat > "$FILE" <<SQL
-- Migration: ${SLUG}
-- Version:   ${VERSION}
-- Generated: ${ISO_TIMESTAMP} by scripts/new-migration.sh
-- Branch:    ${BRANCH}
-- Worktree:  ${WORKTREE}
--
-- Replace this header comment's body below with the actual migration intent
-- (what changed, why, and any rollback notes) per docs/runbooks/migrations.md.

SQL

echo "Created $FILE"
echo "Version: $VERSION"
echo "(Reservation lock left at $LOCK_DIR — harmless, never cleaned up automatically; it just prevents a future run on this machine from picking the same second.)"
