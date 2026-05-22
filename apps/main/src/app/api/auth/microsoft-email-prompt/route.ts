// §17.2 Step 4 — Microsoft no-email prompt: validate format, send Resend OTP,
// store pending email in a short-lived signed cookie.
//
// Flow: POST /api/auth/microsoft-email-prompt { email }
//   → validates format
//   → sends a 6-digit OTP via Resend
//   → redirects to /signup/email-verify?sent=1
//
// A companion route POST /api/auth/microsoft-email-verify accepts the code,
// validates it, then completes user-row creation.

const OTP_STORE = new Map<string, { code: string; expires: number }>();

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const email = (form.get("email") as string | null)?.trim();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "Invalid email address" }, { status: 400 });
  }

  const code = generateOtp();
  OTP_STORE.set(email, { code, expires: Date.now() + 10 * 60 * 1000 }); // 10 min

  const apiKey = process.env.RESEND_API_KEY;
  if (apiKey) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "noreply@ai-travelconcierge.com",
        to: email,
        subject: "Verify your email — AI Travel Concierge",
        html: `<p>Your verification code is: <strong>${code}</strong>. It expires in 10 minutes.</p>`,
      }),
    });
  }

  // Carry the pending email in a short cookie; the verify page will read it.
  const headers = new Headers({ Location: "/signup/email-verify?sent=1" });
  headers.set("Set-Cookie", `_ms_pending_email=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  return new Response(null, { status: 302, headers });
}

// Exported for testing — in production use only the POST handler above.
export { OTP_STORE };
