# Free-text → canonical cruise line/ship matcher (#781, shapes #780)

**Status:** approved design, 2026-06-10. Build blocked by #780 (Phase 1 tables); designed early
on purpose — **one schema recommendation below changes #780** before it's built.
**Decision owner:** operator — chose to design now.

## Problem

`cruise_line` (and ship names) are free text across ~50+ files. "Royal Caribbean" / "RCI" /
"royal caribbean" don't join to scraped knowledge (deck plans, itineraries — keyed by ship).
Phase 2 (#781) backfills FK references and repoints readers, BP38 expand-migrate-contract,
three separate merges. A wrong auto-match silently corrupts CRM rows, so the matcher errs
toward the review queue, never toward a guess.

## Schema recommendation for #780: alias tables, not `aliases text[]`

#780 currently specs `aliases text[]` on `cruise_lines` / `cruise_ships` / `ports`. Replace with
per-entity alias tables:

```sql
CREATE TABLE cruise_line_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cruise_line_id   uuid NOT NULL REFERENCES cruise_lines(id) ON DELETE CASCADE,
  alias            text NOT NULL,             -- as entered/seen
  alias_normalized text NOT NULL UNIQUE,      -- the matcher's lookup key
  source           text NOT NULL CHECK (source IN ('seed','admin','review_queue','import')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id)  -- null for seed/system
);
-- same shape for cruise_ship_aliases, port_aliases
```

Why this matters enough to change #780:
- **Cross-row uniqueness**: an alias must never point at two lines. A `UNIQUE` index on
  `alias_normalized` enforces it in the DB; `text[]` columns can't (only app-side checks, which
  is single-layer enforcement on the exact field the whole join integrity hangs on).
- Indexed exact lookup is the matcher's hot path during backfill and on every CSV import.
- Audit trail (who added an alias, from where) — review-queue approvals become alias rows.

## Matcher pipeline (deterministic, code-first — model never auto-applies)

`resolveCanonical(raw, entityType) → { id } | { review: true }`

1. **Normalize**: lowercase, trim, collapse whitespace, strip punctuation, fold diacritics.
2. **Exact**: normalized form against `slug`, `canonical_name`, `display_name` (normalized).
3. **Alias**: normalized form against `alias_normalized`.
4. **Safe variants**: re-try steps 2–3 after stripping a leading "the" and trailing
   "cruise line" / "cruise lines" / "cruises". (Abbreviations like "RCI" are seed aliases, not
   computed.)
5. **No fuzzy auto-apply.** Anything unmatched goes to the review queue. Levenshtein/trigram and
   AI suggestions exist only as *suggestions inside the queue UI* — a human approves; approval
   inserts an alias row (source `review_queue`), which makes the mapping permanent and
   self-improving.

This is the CLAUDE.md split: code answers routing; the model only drafts a suggestion a human
judges.

## Review queue

```sql
CREATE TABLE canonical_match_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      text NOT NULL CHECK (entity_type IN ('line','ship','port')),
  value_normalized text NOT NULL,
  value_raw        text NOT NULL,             -- a representative original
  occurrence_count integer NOT NULL DEFAULT 1,
  sources          jsonb NOT NULL DEFAULT '[]', -- [{table, column, count}]
  suggested_id     uuid,                      -- nullable; trigram or AI suggestion
  suggestion_note  text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','mapped','ignored')),
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, value_normalized)
);
```

Platform-admin UI (extends #780's admin screen): pending list sorted by `occurrence_count`,
pick-canonical dropdown (suggestion pre-selected when present), "map" (→ alias row + immediate
re-backfill of rows holding that value) or "ignore" (junk values — e.g. "n/a"). `mapped` rows are
the receipts for how every alias came to exist.

## Backfill job

- One batched job per consuming table (quotes, bookings, quote_options, group bookings,
  price_watches, …), id-cursor + time-budget drain loop (the #774 pattern — no LIMIT-without-
  cursor starvation).
- For each row with free text and NULL FK: run the matcher; matched → write `cruise_line_id` /
  `cruise_ship_id` (free text untouched — expand phase); unmatched → upsert the review-queue row
  (increment `occurrence_count`).
- Idempotent and re-runnable; re-run after each review-queue mapping session until pending ≈ 0.

## Sequencing (BP38 — three separate merges, plus the queue)

1. **Expand**: nullable FK columns + alias/review tables + backfill job. Merge.
2. Review-queue burn-down (operator + admin UI) until unmatched is empty or ignored.
3. **Switch reads**: grep EVERY reader (`grep -rn cruise_line apps/*/src` — strings, tsc is
   blind), repoint to FK joins; imports resolve via matcher at ingest, flagging unmatched in the
   import UI (never silently dropped). Merge.
4. **Contract**: drop free-text columns, own PR, after step 3 is live
   (`pnpm check:dropped-columns` backstop). Merge.

## Acceptance criteria

Unchanged from #781, plus: no auto-applied mapping below exact/alias confidence; every
non-seed alias traceable to a human approval or an admin edit.
