/**
 * dependency-ignore-watch notifier.
 *
 * For each entry in .github/dependency-ignore-watch.json, fetch the
 * gating package's latest manifest from the npm registry, read its
 * peerDependencies range for the relevant key, and decide whether the
 * blocked major is now admitted. When it is, open (idempotently) a
 * GitHub issue prompting a re-test + ignore removal.
 *
 * Run:
 *   pnpm tsx scripts/check-dependency-ignores.ts
 *
 * In CI (the monthly dependency-ignore-watch workflow) GH_TOKEN +
 * GITHUB_REPOSITORY are set, so issues are opened via `gh`. Run locally
 * without them and it just prints decisions (no issue side-effects).
 *
 * Exit codes: 0 on normal completion (regardless of clearances); 1 only
 * on a hard error (config parse failure, npm unreachable for every
 * watch) so a genuine breakage shows red but a clear/no-clear result
 * does not.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { execFileSync } from "node:child_process";
import { parseWatchConfig, isBlockerCleared, type IgnoreWatch } from "./lib/dependency-ignore-watch";

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(REPO_ROOT, ".github/dependency-ignore-watch.json");
const ISSUE_LABEL = "dependency-ignore-watch";

interface NpmManifest {
  version?: string;
  peerDependencies?: Record<string, string>;
}

async function fetchPeerRange(gatedBy: string, peerKey: string): Promise<{ version: string; range: string | undefined }> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(gatedBy)}/latest`);
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${gatedBy}/latest`);
  }
  const manifest = (await res.json()) as NpmManifest;
  return {
    version: manifest.version ?? "unknown",
    range: manifest.peerDependencies?.[peerKey],
  };
}

function ghAvailable(): boolean {
  return Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
}

function issueTitle(w: IgnoreWatch): string {
  return `[dependency-ignore-watch] ${w.ignored} ${w.blocked_major} may now be unblocked by ${w.gated_by}`;
}

function existingOpenIssue(title: string): boolean {
  try {
    const out = execFileSync(
      "gh",
      ["issue", "list", "--state", "open", "--search", title, "--json", "title", "--jq", `[.[] | select(.title == ${JSON.stringify(title)})] | length`],
      { encoding: "utf8" },
    ).trim();
    return Number(out) > 0;
  } catch {
    // If the search fails, err toward NOT creating a duplicate is wrong
    // here (we'd silently never notify). Err toward attempting creation;
    // a duplicate issue is a minor annoyance vs a missed signal.
    return false;
  }
}

function openIssue(w: IgnoreWatch, gatingVersion: string, gatingRange: string): void {
  const title = issueTitle(w);
  if (existingOpenIssue(title)) {
    console.log(`[watch] issue already open for ${w.ignored} ${w.blocked_major} — skipping`);
    return;
  }
  const body = [
    `\`${w.gated_by}@${gatingVersion}\` now declares \`peerDependencies.${w.peer_key} = "${gatingRange}"\`, which admits **${w.ignored} ${w.blocked_major}.x**.`,
    ``,
    `That means the upstream incompatibility behind the \`${w.ignored}\` semver-major ignore in \`.github/dependabot.yml\` **may** be cleared.`,
    ``,
    `## Why the ignore exists`,
    `${w.reason} (${w.ref})`,
    ``,
    `## Next steps`,
    `1. On a test branch, remove the \`${w.ignored}\` ignore from \`.github/dependabot.yml\` (or just bump \`${w.ignored}\` to the new major in the lockfile).`,
    `2. Run \`pnpm verify\`. The original break (${w.ref}) should be gone.`,
    `3. If green: merge the ignore removal and let Dependabot propose the major. If still broken: leave the ignore, comment here with the new failure, and close this issue — the watch will re-open it only if the peer range changes again.`,
    ``,
    `> A declared peerDependencies range is upstream's *claim* of support, not proof. ${w.gated_by === "vitest" ? "Note: vitest historically declared vite-8 support before the JSX-transform break was actually fixed — re-test, don't assume." : "Re-test before trusting it."}`,
    ``,
    `_Opened by the \`dependency-ignore-watch\` workflow._`,
  ].join("\n");

  try {
    execFileSync("gh", ["issue", "create", "--title", title, "--label", ISSUE_LABEL, "--body", body], {
      encoding: "utf8",
      stdio: "inherit",
    });
    console.log(`[watch] opened issue: ${title}`);
  } catch (err) {
    console.error(`[watch] failed to open issue for ${w.ignored}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const config = parseWatchConfig(fs.readFileSync(CONFIG_PATH, "utf8"));
  console.log(`[watch] checking ${config.watches.length} ignored dependency(ies)...`);

  let reachable = 0;
  let cleared = 0;

  for (const w of config.watches) {
    let peer: { version: string; range: string | undefined };
    try {
      peer = await fetchPeerRange(w.gated_by, w.peer_key);
      reachable++;
    } catch (err) {
      console.warn(`[watch] could not check ${w.ignored} (gated by ${w.gated_by}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const isCleared = isBlockerCleared(peer.range, w.blocked_major);
    console.log(
      `[watch] ${w.ignored} ${w.blocked_major}: ${w.gated_by}@${peer.version} peer.${w.peer_key}="${peer.range ?? "(none)"}" → ${isCleared ? "CLEARED (re-test candidate)" : "still blocked"}`,
    );

    if (isCleared) {
      cleared++;
      if (ghAvailable()) {
        openIssue(w, peer.version, peer.range ?? "");
      } else {
        console.log(`[watch] (no GH_TOKEN — skipping issue creation for ${w.ignored})`);
      }
    }
  }

  if (reachable === 0 && config.watches.length > 0) {
    throw new Error("could not reach the npm registry for any watch — network failure, not a clear/no-clear result");
  }
  console.log(`[watch] done: ${reachable}/${config.watches.length} checked, ${cleared} cleared.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
