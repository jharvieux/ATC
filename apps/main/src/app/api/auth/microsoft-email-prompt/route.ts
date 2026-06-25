// §17.2 Step 4 — no-email recovery: validate email, send Resend OTP, stash the
// auth-keyed OTP + the pending email cookie.
//
// F-auth-01 (#1379): this route REQUIRES an authenticated session. It is only
// reachable after an OAuth login that returned no email (the callback creates
// the auth user + session, then bounces here), so a session always exists — and
// requiring it stops an unauthenticated party from minting OTP emails to
// arbitrary addresses (email-bombing) or slow-brute-forcing a victim's code.
// The OTP is keyed by auth_user_id; the brute-force `attempts` budget is carried
// across re-mints; and per-IP + per-email regeneration caps bound abuse.
//
// Fail loud, never silent: if RESEND_API_KEY is unset OR Resend returns
// non-OK, the OTP is purged and the route surfaces a 5xx. Without that guard
// the OTP would sit in OTP_STORE and any 6-digit guess inside the 10-minute
// window could bind an auth identity to the entered email — D-091 Pattern 3.

import { randomInt } from "node:crypto";
import { OTP_STORE } from "@/lib/auth/otp-store";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";

// CSPRNG, not Math.random(): this OTP gates auth-identity binding, so a
// predictable value would let an attacker brute-force the 10-min window.
// randomInt's upper bound is exclusive → [100000, 999999], always 6 digits.
function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

// In-process OTP-mint (regeneration) caps — bound email-bombing and slow
// brute-force-via-re-mint. These count MINTS, not guesses (guesses are capped by
// OtpEntry.attempts). Per-instance only; acceptable for the low-concurrency
// §17.2 OTP flow (#1379), Redis upgrade tracked in #735.
const REGEN_WINDOW_MS = 15 * 60 * 1000;
const PER_IP_REGEN_LIMIT = 10;
const PER_EMAIL_REGEN_LIMIT = 5;
const REGEN_SWEEP_THRESHOLD = 1000;
interface RegenEntry {
  count: number;
  windowStart: number;
}
// inmem-ratelimit-allow: low-concurrency §17.2 OTP mint cap; per-email cap + auth.users unique-email are the real controls, Redis tracked in #735
const ipRegen = new Map<string, RegenEntry>();
// inmem-ratelimit-allow: low-concurrency §17.2 OTP mint cap; Redis tracked in #735
const emailRegen = new Map<string, RegenEntry>();

// Returns false when `key` is over `limit` in the current window.
function bumpRegen(map: Map<string, RegenEntry>, key: string, limit: number): boolean {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > REGEN_WINDOW_MS) {
    if (map.size > REGEN_SWEEP_THRESHOLD) {
      for (const [k, v] of map) {
        if (now - v.windowStart > REGEN_WINDOW_MS) map.delete(k);
      }
    }
    map.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

export function _resetRegenForTests(): void {
  ipRegen.clear();
  emailRegen.clear();
}

export async function POST(req: Request): Promise<Response> {
  // F-auth-01: require an authenticated session (the post-OAuth-no-email bounce
  // always has one). Key the OTP by this identity, not by the typed email.
  const supabase = createRequestScopedClient(req);
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return Response.json({ error: "session_required" }, { status: 401 });
  }
  const authUserId = authData.user.id;

  const form = await req.formData();
  const email = (form.get("email") as string | null)?.trim();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }

  // Regeneration caps (per-IP + per-email). Checked after validation so a
  // malformed email can't burn a slot.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (
    !bumpRegen(ipRegen, ip, PER_IP_REGEN_LIMIT) ||
    !bumpRegen(emailRegen, email.toLowerCase(), PER_EMAIL_REGEN_LIMIT)
  ) {
    return Response.json(
      { error: "Too many verification requests. Please try again in 15 minutes." },
      { status: 429 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "email_service_not_configured" }, { status: 503 });
  }

  const code = generateOtp();
  // Carry the brute-force attempts budget across re-mints so requesting a new
  // code can't reset an attacker's guess counter (F-auth-01).
  const prevAttempts = OTP_STORE.get(authUserId)?.attempts ?? 0;
  OTP_STORE.set(authUserId, {
    code,
    email,
    expires: Date.now() + 10 * 60 * 1000, // 10 min
    attempts: prevAttempts,
  });

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "noreply@ai-travelconcierge.com",
      to: email,
      subject: "Verify your email — AI Travel Concierge",
      html: `<p>Your verification code is: <strong>${code}</strong>. It expires in 10 minutes.</p>`,
    }),
  }).catch(() => null);

  if (!resp || !resp.ok) {
    // Purge the OTP — leaving it would let any guess against this session
    // succeed even though no email was sent.
    OTP_STORE.delete(authUserId);
    return Response.json({ error: "email_send_failed" }, { status: 502 });
  }

  // Carry the pending email in a short cookie; the verify page reads it as the
  // email to bind (the OTP itself is keyed by the session, not this cookie).
  const headers = new Headers({ Location: "/signup/email-verify?sent=1" });
  headers.set(
    "Set-Cookie",
    `_ms_pending_email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}
