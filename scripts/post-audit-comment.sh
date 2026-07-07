#!/usr/bin/env bash
# Post an audit agent's hash-bound marker comment to an explicit PR, or check
# whether a PR's already-posted markers are still current.
#
# Usage:
#   scripts/post-audit-comment.sh <pr-number> <marker-prefix> <report-file>
#     pr-number     : the target PR's number — REQUIRED, no ambient/cwd resolution
#     marker-prefix : d091-audit:v1 | prepr-audit:v1
#     report-file   : file with the comment body (the marker line is prepended)
#
#   scripts/post-audit-comment.sh --check <pr-number>
#     Recomputes the PR's current diff hash and compares it against the most
#     recently posted d091-audit:v1 / prepr-audit:v1 marker comments. Prints
#     current/stale/missing per marker, posts nothing, and exits 0 iff both
#     markers are current (1 otherwise) — the deterministic "do I actually
#     need to re-audit this PR" check for merge trains (#1671).
#
# The PR number is always caller-supplied — never inferred from `gh pr view`
# on the cwd's checked-out branch. That ambient resolution used to let a
# shell running in the wrong git worktree silently post to the wrong PR,
# where it would still validly satisfy that PR's diff-hash gate (see #1665).
# To catch a wrong-PR-number typo AND a wrong-worktree cwd in one check, the
# posting path cross-verifies the resolved PR's headRefName against the
# actual checked-out branch and refuses to post on any mismatch. --check is
# read-only (no comment posted) so it skips that branch check.
#
# The jq filter line below MUST stay byte-identical to the one in
# .github/workflows/pr-audit-section-check.yml — the gate recomputes the hash
# from the PR files API and passes iff a comment embeds the matching value.
# A drift guard in that workflow enforces the jq-line match. The hash-
# extraction tail differs in form (macOS shasum fallback here) but must keep
# producing the same hex digest. Both the posting path and --check call the
# same compute_diff_hash() below so the recipe is single-sourced in this file.
set -euo pipefail

# sha256 of a PR's effective diff: sorted (filename + patch) pairs; binaries
# (no patch field) substitute (filename + sha + status). `--paginate --slurp`
# collects pages into an array of arrays; `[.[][]]` flattens before sort.
# sha256sum on Linux/CI, shasum on macOS — identical hex either way.
compute_diff_hash() {
  local repo="$1" pr="$2"
  gh api --paginate --slurp "repos/$repo/pulls/$pr/files" \
    | jq -r '[.[][]] | sort_by(.filename)[] | if .patch then (.filename + "\n" + .patch) else (.filename + "\n" + .sha + "\n" + .status) end' \
    | (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}'
}

if [ "${1:-}" = "--check" ]; then
  PR="${2:?usage: post-audit-comment.sh --check <pr-number>}"
  case "$PR" in
    ''|*[!0-9]*)
      echo "post-audit-comment --check: PR number must be numeric, got '$PR'" >&2
      exit 1
      ;;
  esac

  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  CURRENT_HASH=$(compute_diff_hash "$REPO" "$PR")

  # All issue comments on the PR, oldest-first — take the LAST match per
  # marker prefix so a re-post after a fix-commit supersedes the earlier one.
  COMMENTS=$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq '.[].body')

  ALL_CURRENT=0
  for MARKER_PREFIX in "d091-audit:v1" "prepr-audit:v1"; do
    POSTED_HASH=$(printf '%s\n' "$COMMENTS" \
      | grep -oE "<!-- ${MARKER_PREFIX} diff:[0-9a-f]+ -->" \
      | tail -1 \
      | grep -oE '[0-9a-f]{64}' || true)

    if [ -z "$POSTED_HASH" ]; then
      echo "$MARKER_PREFIX: missing (no marker comment found on PR #$PR)"
      ALL_CURRENT=1
    elif [ "$POSTED_HASH" = "$CURRENT_HASH" ]; then
      echo "$MARKER_PREFIX: current (diff:$POSTED_HASH)"
    else
      echo "$MARKER_PREFIX: stale (posted diff:$POSTED_HASH, current diff:$CURRENT_HASH)"
      ALL_CURRENT=1
    fi
  done

  exit "$ALL_CURRENT"
fi

PR="${1:?usage: post-audit-comment.sh <pr-number> <marker-prefix> <report-file>}"
MARKER_PREFIX="${2:?usage: post-audit-comment.sh <pr-number> <marker-prefix> <report-file>}"
REPORT_FILE="${3:?usage: post-audit-comment.sh <pr-number> <marker-prefix> <report-file>}"

case "$PR" in
  ''|*[!0-9]*)
    echo "post-audit-comment: PR number must be numeric, got '$PR'" >&2
    exit 1
    ;;
esac

CUR_BRANCH=$(git branch --show-current)
if [ -z "$CUR_BRANCH" ]; then
  echo "post-audit-comment: refusing to post — cwd is in detached HEAD (no current branch), can't verify PR #$PR belongs here." >&2
  exit 1
fi

HEAD_REF=$(gh pr view "$PR" --json headRefName --jq .headRefName 2>/dev/null || true)
if [ -z "$HEAD_REF" ]; then
  echo "post-audit-comment: could not resolve PR #$PR (not found, no access, or gh auth issue) — open the PR first, or run the agent in local (report-only) mode." >&2
  exit 1
fi

if [ "$HEAD_REF" != "$CUR_BRANCH" ]; then
  echo "post-audit-comment: refusing to post — PR #$PR head is '$HEAD_REF' but cwd branch is '$CUR_BRANCH' (wrong PR number, or wrong worktree?)" >&2
  exit 1
fi

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
DIFF_HASH=$(compute_diff_hash "$REPO" "$PR")

BODY_TMP=$(mktemp)
trap 'rm -f "$BODY_TMP"' EXIT
printf '<!-- %s diff:%s -->\n' "$MARKER_PREFIX" "$DIFF_HASH" > "$BODY_TMP"
cat "$REPORT_FILE" >> "$BODY_TMP"
gh pr comment "$PR" --body-file "$BODY_TMP"
echo "Posted $MARKER_PREFIX comment on PR #$PR (diff:$DIFF_HASH)"
