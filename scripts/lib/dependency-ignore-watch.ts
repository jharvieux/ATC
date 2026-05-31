// Pure logic for the dependency-ignore-watch notifier.
//
// A dependabot `ignore` is permanent + silent: once we hold a dep at a
// major to dodge an upstream incompatibility, nothing re-proposes the
// upgrade when the incompatibility clears. This module answers the
// poll-able question "does the gating package's peerDependencies range
// now admit the blocked major?" — the signal that it's time to re-test
// and remove the ignore.
//
// I/O (npm fetch, GitHub issue creation) lives in the orchestrator
// script; this file is pure so the range logic is unit-testable.

import semver from "semver";

export interface IgnoreWatch {
  ignored: string;
  blocked_major: number;
  // The package whose peerDependencies range gates the upgrade, and which
  // key within it to read (these two are the non-obvious fields; the rest
  // are self-describing — full schema in docs/runbooks/dependency-ignore-watch.md).
  gated_by: string;
  peer_key: string;
  reason: string;
  ref: string;
}

export interface WatchConfig {
  watches: IgnoreWatch[];
}

export function parseWatchConfig(raw: string): WatchConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { watches?: unknown }).watches)) {
    throw new Error("dependency-ignore-watch config: missing or non-array `watches`");
  }
  const watches = (parsed as { watches: unknown[] }).watches.map((w, i): IgnoreWatch => {
    const o = w as Record<string, unknown>;
    for (const key of ["ignored", "gated_by", "peer_key", "reason", "ref"] as const) {
      if (typeof o[key] !== "string" || (o[key] as string).length === 0) {
        throw new Error(`dependency-ignore-watch config: watch[${i}].${key} must be a non-empty string`);
      }
    }
    if (typeof o.blocked_major !== "number" || !Number.isInteger(o.blocked_major) || o.blocked_major < 1) {
      throw new Error(`dependency-ignore-watch config: watch[${i}].blocked_major must be a positive integer`);
    }
    return {
      ignored: o.ignored as string,
      blocked_major: o.blocked_major,
      gated_by: o.gated_by as string,
      peer_key: o.peer_key as string,
      reason: o.reason as string,
      ref: o.ref as string,
    };
  });
  return { watches };
}

/**
 * True when the gating package's declared peer range admits ANY version
 * in the blocked major — i.e. upstream now claims support, so the ignore
 * is a re-test candidate. Uses range intersection (not a single
 * point-version check) so a range like `^10.2.0` still counts as
 * admitting major 10.
 */
export function isBlockerCleared(
  peerRange: string | undefined | null,
  blockedMajor: number,
): boolean {
  if (!peerRange || peerRange.trim().length === 0) return false;
  try {
    return semver.intersects(peerRange, `${blockedMajor}.x`, { includePrerelease: false });
  } catch {
    // semver.intersects throws on ranges it can't parse — e.g. a git URL
    // (`git+https://…`) or a workspace protocol (`workspace:*`). Those
    // aren't a clear signal, so treat as not-cleared rather than letting
    // the monthly poll fail loud on an upstream's non-semver peer string.
    // (Note `"*"` is NOT in this bucket — it parses and intersects true.)
    return false;
  }
}
