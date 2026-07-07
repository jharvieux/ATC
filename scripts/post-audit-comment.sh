#!/usr/bin/env bash
# Post an audit agent's hash-bound marker comment to an explicit PR.
#
# Usage: scripts/post-audit-comment.sh <pr-number> <marker-prefix> <report-file>
#   pr-number     : the target PR's number — REQUIRED, no ambient/cwd resolution
#   marker-prefix : d091-audit:v1 | prepr-audit:v1
#   report-file   : file with the comment body (the marker line is prepended)
#
# The PR number is always caller-supplied — never inferred from `gh pr view`
# on the cwd's checked-out branch. That ambient resolution used to let a
# shell running in the wrong git worktree silently post to the wrong PR,
# where it would still validly satisfy that PR's diff-hash gate (see #1665).
# To catch a wrong-PR-number typo AND a wrong-worktree cwd in one check, we
# cross-verify the resolved PR's headRefName against the actual checked-out
# branch and refuse to post on any mismatch.
#
# The jq filter line below MUST stay byte-identical to the one in
# .github/workflows/pr-audit-section-check.yml — the gate recomputes the hash
# from the PR files API and passes iff a comment embeds the matching value.
# A drift guard in that workflow enforces the jq-line match. The hash-
# extraction tail differs in form (macOS shasum fallback here) but must keep
# producing the same hex digest.
set -euo pipefail

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

# sha256 of the PR's effective diff: sorted (filename + patch) pairs; binaries
# (no patch field) substitute (filename + sha + status). `--paginate --slurp`
# collects pages into an array of arrays; `[.[][]]` flattens before sort.
# sha256sum on Linux/CI, shasum on macOS — identical hex either way.
DIFF_HASH=$(gh api --paginate --slurp "repos/$REPO/pulls/$PR/files" \
  | jq -r '[.[][]] | sort_by(.filename)[] | if .patch then (.filename + "\n" + .patch) else (.filename + "\n" + .sha + "\n" + .status) end' \
  | (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}')

BODY_TMP=$(mktemp)
trap 'rm -f "$BODY_TMP"' EXIT
printf '<!-- %s diff:%s -->\n' "$MARKER_PREFIX" "$DIFF_HASH" > "$BODY_TMP"
cat "$REPORT_FILE" >> "$BODY_TMP"
gh pr comment "$PR" --body-file "$BODY_TMP"
echo "Posted $MARKER_PREFIX comment on PR #$PR (diff:$DIFF_HASH)"
