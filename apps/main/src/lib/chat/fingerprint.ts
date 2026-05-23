// §24.8 — Server-derived client fingerprint.
//
// Best-effort, not cryptographic. The fingerprint is a hash of (user-agent,
// accept-language, optional client-hints from sec-ch-* headers). Defeats
// casual evasion; sophisticated adversaries hit the IP and session layers
// instead.

import { createHash } from "node:crypto";

export function deriveFingerprint(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  const al = req.headers.get("accept-language") ?? "";
  // Client hints (modern browsers, opt-in via Accept-CH)
  const platform = req.headers.get("sec-ch-ua-platform") ?? "";
  const mobile   = req.headers.get("sec-ch-ua-mobile") ?? "";
  const brand    = req.headers.get("sec-ch-ua") ?? "";
  const viewport = req.headers.get("viewport-width") ?? "";
  // Optional client-supplied canvas/screen hints — sent by chat UI when
  // available; falls back to "" otherwise. Header name kept short.
  const clientHint = req.headers.get("x-atc-client-hint") ?? "";

  const composite = [ua, al, platform, mobile, brand, viewport, clientHint].join("|");
  return createHash("sha256").update(composite).digest("hex").slice(0, 32);
}

export function extractClientIp(req: Request): string {
  // Vercel-friendly header order.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  // Fallback: edge functions get this header; node runtimes get socket info
  // not reachable here. Empty IP means anonymous limit can only use session
  // + fingerprint.
  return req.headers.get("cf-connecting-ip") ?? "";
}
