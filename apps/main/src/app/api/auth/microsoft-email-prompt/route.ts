// §17.2 Step 4 — no-email recovery: validate email, send Resend OTP, stash
// the pending email in a short cookie.
//
// Flow: POST /api/auth/microsoft-email-prompt { email }
//   → validates format
//   → sends a 6-digit OTP via Resend
//   → redirects to /signup/email-verify?sent=1
//
// Fail loud, never silent: if RESEND_API_KEY is unset OR Resend returns
// non-OK, the OTP is purged and the route surfaces a 5xx. Without that
// guard, the OTP would sit in OTP_STORE and any 6-digit guess inside the
// 10-minute window could bind an attacker's auth identity to a victim's
// email — D-091 fail-open + Pattern 3 (silent enforcement skip).

import { OTP_STORE } from "@/lib/auth/otp-store";

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const email = (form.get("email") as string | null)?.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "email_service_not_configured" },
      { status: 503 },
    );
  }

  const code = generateOtp();
  OTP_STORE.set(email, {
    code,
    expires: Date.now() + 10 * 60 * 1000, // 10 min
    attempts: 0,
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
    // Purge the OTP — leaving it would let any guess against this email
    // succeed even though no email was sent.
    OTP_STORE.delete(email);
    return Response.json({ error: "email_send_failed" }, { status: 502 });
  }

  // Carry the pending email in a short cookie; the verify page reads it as
  // the binding authority for which row to create.
  const headers = new Headers({ Location: "/signup/email-verify?sent=1" });
  headers.set(
    "Set-Cookie",
    `_ms_pending_email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

// OTP_STORE is imported from @/lib/auth/otp-store — import from there for testing.
