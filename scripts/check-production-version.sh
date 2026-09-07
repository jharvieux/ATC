#!/usr/bin/env bash
# Fails unless a hosted health endpoint identifies the expected Vercel revision.
#
# Usage: bash scripts/check-production-version.sh [URL] EXPECTED_SHA [EXPECTED_SERVICE]
# Default URL: https://ai-travelconcierge.com/api/health

set -euo pipefail

HEALTH_URL="${1:-https://ai-travelconcierge.com/api/health}"
EXPECTED_SHA="${2:-}"
EXPECTED_SERVICE="${3:-main}"

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "ERROR: EXPECTED_SHA must be a full 40-character Git SHA." >&2
  exit 1
fi

echo "==> Querying health endpoint: $HEALTH_URL"

RESPONSE=$(curl -sf "$HEALTH_URL" 2>/dev/null) || {
  echo "ERROR: Failed to reach $HEALTH_URL" >&2
  exit 1
}

printf '%s' "$RESPONSE" | node -e '
  const fs = require("node:fs");
  const expectedSha = process.argv[1].toLowerCase();
  const expectedService = process.argv[2];
  let health;
  try {
    health = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    console.error("ERROR: Health endpoint did not return valid JSON.");
    process.exit(1);
  }
  if (health.status !== "ok") {
    console.error(`ERROR: Health status is ${JSON.stringify(health.status)}; expected "ok".`);
    process.exit(1);
  }
  if (health.service !== expectedService) {
    console.error(`ERROR: Health service is ${JSON.stringify(health.service)}; expected ${JSON.stringify(expectedService)}.`);
    process.exit(1);
  }
  if (health.commitSource !== "vercel") {
    console.error(`ERROR: Hosted commit source is ${JSON.stringify(health.commitSource)}; expected "vercel".`);
    process.exit(1);
  }
  if (typeof health.commit !== "string" || !/^[0-9a-f]{40}$/i.test(health.commit)) {
    console.error(`ERROR: Hosted commit is missing, unknown, or malformed: ${JSON.stringify(health.commit)}.`);
    process.exit(1);
  }
  if (health.commit.toLowerCase() !== expectedSha) {
    console.error(`ERROR: Hosted commit mismatch: expected=${expectedSha} hosted=${health.commit}.`);
    process.exit(1);
  }
' "$EXPECTED_SHA" "$EXPECTED_SERVICE"

echo "OK: $EXPECTED_SERVICE is serving expected revision $EXPECTED_SHA."
