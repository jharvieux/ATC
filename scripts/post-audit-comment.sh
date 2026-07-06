#!/usr/bin/env bash
# Post an audit agent's hash-bound marker comment to the current branch's PR.
#
# Usage: scripts/post-audit-comment.sh <marker-prefix> <report-file>
#   marker-prefix : d091-audit:v1 | prepr-audit:v1
#   report-file   : file with the comment body (the marker line is prepended)
#
# The jq filter line below MUST stay byte-identical to the one in
# .github/workflows/pr-audit-section-check.yml — the gate recomputes the hash
# from the PR files API and passes iff a comment embeds the matching value.
# A drift guard in that workflow enforces the jq-line match. The hash-
# extraction tail differs in form (macOS shasum fallback here) but must keep
# producing the same hex digest.
set -euo pipefail

MARKER_PREFIX="${1:?usage: post-audit-comment.sh <marker-prefix> <report-file>}"
REPORT_FILE="${2:?usage: post-audit-comment.sh <marker-prefix> <report-file>}"

PR=$(gh pr view --json number --jq .number 2>/dev/null || true)
if [ -z "$PR" ]; then
  echo "post-audit-comment: no PR for the current branch — open the PR first, or run the agent in local (report-only) mode." >&2
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
