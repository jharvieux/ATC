// §7.1 — Server-side session signout.
//
// POST /api/auth/signout
//
// With §17.x HttpOnly cookies the browser cannot end its own session —
// the cookies are JS-invisible by design — so the server must clear
// them. supabase.auth.signOut() invalidates the session server-side
// AND emits cookie writes with maxAge:0 via the setAll adapter;
// applyAuthCookies flushes those Set-Cookie headers onto the response.
//
// No assertPermission: signing out is intentionally idempotent and
// always safe — even for a request with no/expired session, the worst
// outcome is "clears cookies that weren't there." CSRF posture: the
// auth cookies are SameSite=Lax, so a cross-origin POST doesn't carry
// them, so a forged signout from another site has nothing to clear.

import { NextResponse, type NextRequest } from "next/server";
import { createRouteHandlerClient } from "@/lib/auth/ssr-client";

export async function POST(req: NextRequest): Promise<Response> {
  const { supabase, applyAuthCookies } = createRouteHandlerClient(req);
  await supabase.auth.signOut();
  return applyAuthCookies(new NextResponse(null, { status: 204 }));
}
