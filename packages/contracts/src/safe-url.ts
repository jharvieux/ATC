// Shared URL validator for stored-then-rendered URL fields (source_url,
// image_url, source_page_url). Replaces a bare z.string().url(), whose
// underlying `new URL()` accepts file://, http://169.254.169.254 (cloud
// metadata), and internal/loopback/link-local hosts — none of which should be
// persisted from an ingest/approve/media-asset request and later rendered into
// an <img src>/<a href> client sink (F-rag-pii-02, Day-1 scan).
//
// Two guards: (1) scheme allowlist — http/https only (kills file:, data:,
// javascript:, gopher:, etc.); (2) host denylist — loopback, link-local (incl.
// cloud metadata 169.254.169.254), private RFC1918, CGNAT, and unqualified
// single-label hosts, in decimal/octal/hex IPv4, IPv6, and v4-mapped forms.
//
// Residual (documented, not closed here): a registered DNS name that RESOLVES
// to an internal address passes — validation is synchronous and must not do
// DNS. The render-sink http(s) gate + any server-side fetch SSRF guard are the
// belt-and-suspenders for that case.

import { z } from "zod";

// NOTE: `new URL()` (WHATWG) has already normalized numeric IPv4 forms before
// this runs — decimal (2130706433), hex (0x7f000001), and octal all become
// dotted-decimal "127.0.0.1". So the dotted-octet range check below catches
// them; we don't re-parse those encodings here.
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;

  // IPv6: loopback / unspecified / link-local (fe80::/10) / unique-local
  // (fc00::/7) / any IPv4-mapped (::ffff:…, which URL renders in hex so we deny
  // the whole class — no legitimate public URL uses a v4-mapped literal).
  if (host === "::1" || host === "::") return true;
  if (
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("::ffff:")
  ) {
    return true;
  }

  // Dotted-decimal IPv4 ranges (URL-normalized; see note above).
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
    const a = Number(octets[0]);
    const b = Number(octets[1]);
    if (a === 0 || a === 127 || a === 10) return true; // 0.0.0.0/8, loopback, RFC1918
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }

  // Unqualified single-label hostname (no dot, not an IP) — internal-only names.
  if (!host.includes(".") && !host.includes(":")) return true;

  return false;
}

export const safeUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      // z.string().url() already verified parsability; this is defensive only.
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      return !isBlockedHost(parsed.hostname);
    },
    { message: "URL must be http(s) and must not target an internal, loopback, or link-local host" },
  );
