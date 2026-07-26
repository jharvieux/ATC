---
description: Draft a properly-formatted MEMORY.md decision entry and prepend it to the file. Enforces the CLAUDE.md format (Decision / Why / Rejected / Related artifacts) and the prepend-only invariant.
---

# /memory-entry — append a decision to MEMORY.md

You are appending a new entry to `/MEMORY.md` per the protocol in `/CLAUDE.md`. The PreToolUse hook at `.claude/hooks/block-spec-memory-edits.mjs` will block any Write that doesn't strictly prepend, so follow the steps below exactly.

## Required information

If `$ARGUMENTS` is empty, ask the user for these four fields one at a time (don't dump them all in one question — `AskUserQuestion` works for the format choice, but the substance is open-ended text):

1. **Short title** (≤ 70 chars) — what the decision is. Example: *"Keep `react-hooks/set-state-in-effect` disabled"*.
2. **Decision** — the actual call, in 1–3 sentences. State it as a fact: "We will X" or "X is now Y."
3. **Why** — the reasoning. What constraint, incident, or trade-off forced this. Bulletable if there are multiple reasons.
4. **Rejected** — the alternatives considered and why they lost. Even "considered the obvious thing, rejected because…" is worth recording — future readers will wonder.
5. **Related artifacts** — PRs, files, prior MEMORY entries (`[[D-NNN]]`), spec sections. Anything a future engineer would chase.

If `$ARGUMENTS` is non-empty, treat it as a one-line summary and use it to seed the title; still elicit the four fields.

## Determining the D-NNN number

Read the top of `/MEMORY.md` and find the highest existing `## D-NNN` header. The new entry gets `D-(NNN+1)`. The newest entry always sits at the top.

**Concurrency note (#1661):** this only reads the *local* snapshot of MEMORY.md. If another agent/session is concurrently prepending an entry on a different branch, both of you will compute the same "next" number — that's how #1652 and #1643 both claimed D-318 in one sweep. `scripts/check-memory-decision-collision.ts` (CI) catches the resulting duplicate at PR time; if it fires, re-run this command after rebasing on `dev` to pick up the now-current highest number.

## Date

Use today's date in `YYYY-MM-DD` form. If `${currentDate}` is available from auto-memory, use that. Otherwise read it from the system or ask the user. Do not invent a date.

## Format the entry exactly like this

```markdown
## D-NNN — YYYY-MM-DD — Short title

**Decision.** One to three sentences.

**Why.**
- Reason one.
- Reason two.

**Rejected.**
- *Alternative one.* Why it was rejected.
- *Alternative two.* Why it was rejected.

**Related artifacts.** PR #NNN, `path/to/file.ts`, [[D-NNN]] for prior entries.

---

```

The trailing `---` and blank line are part of the entry — they separate it from the entry below.

## Prepending safely

The CLAUDE.md rule is: *additions only, no edits to prior entries.* The hook enforces it mechanically; two ways to satisfy it:

**Edit (preferred — surgical).** The hook's rule for Edit is literally: `new_string` must *end with* `old_string`. So anchor on the **current newest entry's header line** (it's unique) and repeat that line verbatim at the *end* of `new_string`:

- `old_string` → `## D-365 — 2026-07-19 — <title>` (whatever the top entry happens to be right now)
- `new_string` → `## D-366 — <today> — <title>\n\n<body>\n\n---\n\n## D-365 — 2026-07-19 — <title>`

The new entry lands above the anchor; the anchor survives as the suffix, so the `endsWith` check passes. Pick the anchor so it's unique in the file (the full header line is) — the Edit tool also requires `old_string` to be unique. No need to read MEMORY.md in full: grep the top header line out of it.

**Write (whole-file fallback).** The hook's rule for Write is:

> The new MEMORY.md content must end with the existing file content verbatim (trailing whitespace aside).

Concretely:

1. Read the current `MEMORY.md` in full.
2. Construct the new file content as: `<header line(s)> + <new entry block> + <everything from the first ## D-... line through end of file>`.
3. Write the new content. If the hook blocks you, the content didn't preserve the existing entries — re-read MEMORY.md and try again.

Bigger payload, more truncation risk — prefer Edit.

The file header today is:

```
# MEMORY.md — AI Travel Concierge Decision Log

Newest entries on top.

---

```

Preserve the header verbatim. The new entry goes between the header and the previous newest entry.

## After writing

- **Prepend the one-liner to `MEMORY-INDEX.md`** as the first line under `## Entries`: `- D-NNN — YYYY-MM-DD — <compressed one-line summary>`. This is mandatory — `check:memory-decision-collision` (CI) fails any PR where MEMORY.md and the index files disagree. New entries always go in `MEMORY-INDEX.md`, never directly into `MEMORY-INDEX-ARCHIVE.md` (that file only receives lines moved down from the lean index during sweeps).
- Confirm to the user: *"Added D-NNN — <title>. MEMORY.md now has N entries."* (Count by grepping `^## D-`.)
- Do **not** also update `SESSION.md`. Memory entries and session state are distinct artifacts per CLAUDE.md.

## When to skip running this

- If the "decision" is really just *what was done* (a feature, a fix, a PR description), it belongs in the PR body or `SESSION.md`, not MEMORY.md.
- If the user is in the middle of an in-flight task and just thinking out loud, ask before recording — they may not be at the decision point yet.
- If the entry would duplicate or update an existing one, surface that and ask the user whether to (a) append a follow-up (preferred — preserves history), (b) supersede with a new entry that links back to the old one, or (c) abort. Never silently edit a prior entry.
