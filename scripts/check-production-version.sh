#!/usr/bin/env bash
# Queries the production health endpoint and compares the reported version
# against the most recent git tag.
#
# Usage: bash scripts/check-production-version.sh [URL]
# Default URL: https://ai-travelconcierge.com/api/health

set -euo pipefail

HEALTH_URL="${1:-https://ai-travelconcierge.com/api/health}"

echo "==> Querying health endpoint: $HEALTH_URL"

RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null) || {
  echo "ERROR: Failed to reach $HEALTH_URL" >&2
  exit 1
}

STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
VERSION=$(echo "$RESPONSE" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
SUPABASE=$(echo "$RESPONSE" | grep -o '"supabase":"[^"]*"' | cut -d'"' -f4)

echo ""
echo "  status:           ${STATUS:-<not found>}"
echo "  version (sha):    ${VERSION:-<not found>}"
echo "  checks.supabase:  ${SUPABASE:-<not found>}"
echo ""

# Compare against most recent git tag
LATEST_TAG=$(git tag --sort=-v:refname 2>/dev/null | head -1)
if [[ -z "$LATEST_TAG" ]]; then
  echo "WARNING: No git tags found; cannot compare version."
else
  TAG_SHA=$(git rev-list -n 1 "$LATEST_TAG" 2>/dev/null || echo "")
  echo "  latest git tag:   $LATEST_TAG"
  echo "  tag sha:          ${TAG_SHA:-<not found>}"
  echo ""

  if [[ -n "$VERSION" && -n "$TAG_SHA" ]]; then
    # Compare first 12 chars (short SHA match is sufficient)
    if [[ "${VERSION:0:12}" == "${TAG_SHA:0:12}" ]]; then
      echo "OK: Production is running the latest tagged release ($LATEST_TAG)."
    else
      echo "WARNING: Production SHA does not match latest tag ($LATEST_TAG)."
      echo "         This may indicate a rollback is in effect or the tag"
      echo "         has not been deployed yet."
    fi
  fi
fi

echo ""

if [[ "$STATUS" != "ok" ]]; then
  echo "FAIL: Health status is '$STATUS' (expected 'ok')." >&2
  exit 1
fi

if [[ "$SUPABASE" != "ok" ]]; then
  echo "WARN: Supabase check is '$SUPABASE' — database may be degraded."
fi

exit 0
