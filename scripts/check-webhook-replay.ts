// Webhook replay-protection guard (epic #1393 / G6; Day-1 scan F-rag-wh-02,
// extends D-091 #12 webhook-signature doctrine).
//
// A valid HMAC/signature proves a webhook body was produced by someone holding
// the secret — it does NOT prove the body is FRESH. Without replay protection an
// attacker (or a leaked-then-rotated secret, or a network MITM that captured one
// valid delivery) can re-POST a previously-valid signed body and have it
// re-processed: re-applying a feedback signal to poison retrieval ranking
// (F-rag-wh-02), re-firing a state transition, double-counting an event. Signed
// ≠ idempotent.
//
// Every handler that VERIFIES AN INBOUND SIGNATURE must therefore also carry a
// replay-protection mechanism: a timestamp-tolerance window (Stripe's
// `constructEvent`, Svix's signed timestamp), a dedup/idempotency row keyed on
// the provider's delivery/event id (`stripe_webhook_events`), a nonce, or a
// state-guarded "already handled" check.
//
// Detection (text heuristic, not flow analysis):
//   TRIGGER — the file reads an inbound signature: `req.headers.get("…signature")`
//             / `svix-id` / a `constructEvent(` / a `verify*Signature(` call. This
//             deliberately does NOT trigger on bare `timingSafeEqual` (admin-key
//             and cookie-HMAC compares use it too) or on OUTBOUND signers.
//   REQUIRE — a replay-protection signal somewhere in the same file.
// A triggered file with no replay signal is flagged. Pre-existing gaps are
// baselined (the gate fails on NEW only); a handler whose replay protection
// genuinely lives elsewhere, or an accepted risk, carries an inline
// `webhook-replay-allow:<reason>`.
//
// This is a presence check (is replay protection *considered*?), not a proof of
// correctness — the d091-reviewer + a per-provider replay fixture test cover that.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/webhook-replay-baseline.txt");
const SCAN_DIRS = ["apps/main/src", "apps/rag/src"];

// Reads a signature off the inbound request (verifies a webhook), as opposed to
// computing one to send (outbound) or comparing a non-webhook secret.
const INBOUND_SIG_RE =
  /\.headers\.get\(\s*["'`][a-z0-9-]*signature\b|\.headers\.get\(\s*["'`]svix-id\b|\bconstructEvent\s*\(|\bverify[A-Za-z]*Signature\s*\(/i;

// Any of these means replay was at least considered: a timestamp-tolerance
// window (Stripe constructEvent / Svix signed timestamp), a dedup/idempotency
// row, a nonce, a monotonic version guard (`source_revision >= …` makes a
// replayed delivery a no-op), or a state-guarded "already handled" check.
// NB: a BARE `timestamp` token is deliberately NOT a signal — it matches any
// incidental "created_timestamp" column / comment and would silently exempt an
// unprotected handler. The real timestamp-window paths carry `svix-timestamp` or
// `tolerance`; `constructEvent` covers Stripe's internal tolerance.
const REPLAY_RE =
  /\bconstructEvent\b|_webhook_events\b|idempoten|dedup|\bnonce\b|\breplay\b|svix-timestamp|svix-id|\btolerance\b|source_revision\b|already_|processed_at\b|\.expire\(|seen_at\b|delivery_id\b/i;

export interface WebhookHit {
  key: string; // relpath
}

function isInlineAllowed(content: string): boolean {
  return content.includes("webhook-replay-allow:");
}

// Signature-primitive helpers (`*-signature.ts`, e.g. lib/webhooks/github-signature.ts)
// only compute/verify the HMAC — replay protection is the CALLING handler's job,
// not theirs. They define a `verify*Signature` fn (which trips INBOUND_SIG_RE), so
// exempt them by name; the handlers that call them are still scanned.
function isSignatureHelper(rel: string): boolean {
  return /-signature\.tsx?$/.test(path.basename(rel));
}

export function findUnprotectedWebhooks(rel: string, content: string): WebhookHit[] {
  if (isSignatureHelper(rel)) return [];
  if (!INBOUND_SIG_RE.test(content)) return [];
  if (REPLAY_RE.test(content)) return [];
  if (isInlineAllowed(content)) return [];
  return [{ key: rel }];
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main(): void {
  const hits: WebhookHit[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    // Fail-closed: a missing expected dir means we'd silently skip its files.
    if (!fs.existsSync(abs)) {
      console.error(`Webhook-replay check: expected scan dir missing: ${dir}. Run from repo root.`);
      process.exit(1);
    }
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      hits.push(...findUnprotectedWebhooks(rel, fs.readFileSync(file, "utf8")));
    }
  }

  if (process.argv.includes("--update-baseline")) {
    const header =
      "# Webhook replay-protection guard baseline (#1393/G6). One <relpath> per line.\n" +
      "# Inbound-signature handlers with no replay-protection signal. The gate fails\n" +
      "# on NEW ones. Regenerate: pnpm check:webhook-replay --update-baseline. Prefer\n" +
      "# adding replay protection (timestamp tolerance / dedup row / nonce) over growing this.\n";
    const body = hits
      .map((h) => h.key)
      .sort()
      .join("\n");
    fs.writeFileSync(BASELINE_FILE, `${header}${body}\n`);
    console.log(`Wrote ${hits.length} baseline entr(ies) to ${path.relative(ROOT, BASELINE_FILE)}.`);
    return;
  }

  const baseline = loadBaseline();
  const fresh = hits.filter((h) => !baseline.has(h.key));
  if (fresh.length > 0) {
    console.error("Webhook replay-protection violations — an inbound-signature handler with no replay defense:\n");
    for (const h of fresh) console.error(`  ${h.key}`);
    console.error(
      "\nA valid signature does not prove freshness. Add a timestamp-tolerance window, a " +
        "dedup/idempotency row keyed on the provider's delivery id, or a nonce — and a replay " +
        "fixture test. If protection lives elsewhere or the risk is accepted, add an inline " +
        "`webhook-replay-allow:<reason>`.",
    );
    process.exit(1);
  }

  console.log(
    `Webhook-replay check passed: ${hits.length} grandfathered unprotected handler(s) baselined, 0 new.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
