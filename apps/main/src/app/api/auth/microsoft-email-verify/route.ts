// §17.2 Step 6 — no-email recovery: OTP verification + users-row finalize.
//
// Flow: POST /api/auth/microsoft-email-verify { code }
//   → reads _ms_pending_email cookie (the email the user typed in step 4)
//   → looks up the OTP via OTP_STORE keyed by that email
//   → validates code matches + not expired + under the attempt cap
//   → resolves auth_user_id from the cookie session set by /api/auth/callback
//   → upserts public.users row on tenant domains (platform provisioning is
//     deferred to #441)
//   → clears _ms_pending_email and lands the user on "/"
//
// Provider-neutral despite the route name: the same recovery handles MS
// when Graph turns up nothing AND any other provider (Facebook, future) that
// yields a null email. Rename deferred to avoid a file-move during the
// auth migration PR.

import { NextResponse, type NextRequest } from "next/server";
import { OTP_STORE, MAX_OTP_ATTEMPTS } from "@/lib/auth/otp-store";
import { createRequestScopedClient } from "@/lib/auth/ssr-client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { safeAwait } from "@/lib/db/safe-mutation";
import { RESOLVED_TENANT_ID_HEADER } from "@/lib/tenancy/header-names";

const PENDING_EMAIL_COOKIE = "_ms_pending_email";

export async function POST(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const form = await req.formData();
  const code = (form.get("code") as string | null)?.trim() ?? "";

  const pendingEmail = req.cookies.get(PENDING_EMAIL_COOKIE)?.value;
  if (!pendingEmail) {
    return errorRedirect(
      url,
      "Verification session expired. Please sign in again.",
    );
  }

  if (!/^\d{6}$/.test(code)) {
    return errorRedirect(url, "Enter the 6-digit code from your email.");
  }

  const stored = OTP_STORE.get(pendingEmail);
  if (!stored || stored.expires < Date.now()) {
    OTP_STORE.delete(pendingEmail);
    return errorRedirect(
      url,
      "Verification code expired. Please request a new one.",
    );
  }
  if (stored.attempts >= MAX_OTP_ATTEMPTS) {
    OTP_STORE.delete(pendingEmail);
    return errorRedirect(
      url,
      "Too many attempts. Please request a new code.",
    );
  }
  if (stored.code !== code) {
    stored.attempts += 1;
    OTP_STORE.set(pendingEmail, stored);
    return errorRedirect(url, "Verification code is incorrect.");
  }
  OTP_STORE.delete(pendingEmail);

  // Resolve the auth user from the cookie session set by /api/auth/callback.
  const supabase = createRequestScopedClient(req);
  const { data: authData, error: authErr } = await supabase.auth.getUser();
  if (authErr || !authData?.user) {
    return errorRedirect(url, "Session expired. Please sign in again.");
  }

  // Membership upsert — tenant domains only. The "platform" sentinel means
  // net-new tenant provisioning, which is deferred to #441; the session is
  // already established so the user lands authenticated either way.
  const tenantId = req.headers.get(RESOLVED_TENANT_ID_HEADER);
  if (tenantId && tenantId !== "platform") {
    const svc = createServiceRoleClient();
    await safeAwait(
      svc.from("users").upsert(
        {
          auth_user_id: authData.user.id,
          tenant_id: tenantId,
          email: pendingEmail,
          status: "active",
        },
        { onConflict: "auth_user_id,tenant_id", ignoreDuplicates: false },
      ),
      "auth.email_verify.users.upsert",
    );
  }

  const res = NextResponse.redirect(new URL("/", url.origin), 302);
  res.cookies.set({
    name: PENDING_EMAIL_COOKIE,
    value: "",
    path: "/",
    maxAge: 0,
  });
  return res;
}

function errorRedirect(url: URL, message: string): Response {
  const target = new URL("/auth/error", url.origin);
  target.searchParams.set("message", message);
  return NextResponse.redirect(target, 302);
}
