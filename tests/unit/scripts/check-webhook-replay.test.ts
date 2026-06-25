// #1393/G6 — unit tests for the webhook replay-protection guard's matcher.
//
// Pins WHY the guard exists: a handler that verifies an inbound signature but
// has no replay defense (timestamp/dedup/nonce) can be fed a captured, still-
// valid signed body twice (F-rag-wh-02). The matcher must fire on that shape,
// must NOT fire on protected handlers or on the signature-primitive helpers /
// outbound signers / non-webhook secret compares that share surface tokens.

import { describe, it, expect } from "vitest";
import { findUnprotectedWebhooks } from "../../../scripts/check-webhook-replay";

const J = (...l: string[]) => l.join("\n");

describe("findUnprotectedWebhooks", () => {
  const unprotected = J(
    `const sig = req.headers.get("x-webhook-signature");`,
    `if (!timingSafeEqual(sig, expected)) return json({ error: "invalid_signature" }, 401);`,
    `await db.from("feedback_events").insert(rows);`,
  );

  it("flags an inbound-signature handler with no replay defense", () => {
    expect(findUnprotectedWebhooks("apps/rag/src/app/api/feedback/route.ts", unprotected)).toHaveLength(1);
  });

  it("does NOT flag when a timestamp-tolerance window is present", () => {
    const src = J(unprotected, `const ts = req.headers.get("x-webhook-timestamp"); assertWithinTolerance(ts);`);
    expect(findUnprotectedWebhooks("r.ts", src)).toEqual([]);
  });

  it("does NOT flag when a dedup/idempotency row backs the handler (Stripe shape)", () => {
    const src = J(`const event = stripe.webhooks.constructEvent(body, sig, secret);`, `await db.from("stripe_webhook_events").insert({ id: event.id });`);
    expect(findUnprotectedWebhooks("apps/main/src/lib/stripe/webhook-handler.ts", src)).toEqual([]);
  });

  it("does NOT flag when a state-guarded 'already handled' check is present", () => {
    const src = J(`if (!verifyGithubSignature(body, sig)) return;`, `if (row.status === "closed") return { ok: true, already_closed: true };`);
    expect(findUnprotectedWebhooks("apps/main/src/app/api/webhooks/github/route.ts", src)).toEqual([]);
  });

  it("does NOT flag the signature-primitive helper itself (its job is verify, not replay)", () => {
    const src = `export function verifyGithubSignature(body: string, sig: string): boolean { /* hmac compare */ }`;
    expect(findUnprotectedWebhooks("apps/main/src/lib/webhooks/github-signature.ts", src)).toEqual([]);
  });

  it("does NOT fire on a non-webhook secret compare (admin key via timingSafeEqual, no inbound sig header)", () => {
    const src = J(`const key = req.headers.get("x-api-key");`, `if (!timingSafeEqual(key, ADMIN_KEY)) return unauthorized();`);
    expect(findUnprotectedWebhooks("apps/main/src/app/api/admin/x/route.ts", src)).toEqual([]);
  });

  it("does NOT fire on an outbound signer (computes a signature to send, reads no inbound sig)", () => {
    const src = J(`const sig = await hmacHex(secret, body);`, `await fetch(url, { headers: { "x-webhook-signature": sig } });`);
    expect(findUnprotectedWebhooks("apps/main/src/app/api/admin/tenants/route.ts", src)).toEqual([]);
  });

  it("honors the inline escape hatch (replay protection lives elsewhere / accepted risk)", () => {
    const src = J(`// webhook-replay-allow: dedup handled by the downstream queue consumer`, unprotected);
    expect(findUnprotectedWebhooks("r.ts", src)).toEqual([]);
  });
});
