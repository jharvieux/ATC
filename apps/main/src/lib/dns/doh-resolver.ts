// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §16.3.1 — DNS-over-HTTPS resolver for custom-domain verification.
//
// Cloudflare and Google both implement RFC 8484 with JSON response support
// via the "Accept: application/dns-json" header. Default to Cloudflare.

const DNS_TYPE_CNAME = 5;
const DNS_TYPE_TXT = 16;

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

async function dohLookup(name: string, type: number): Promise<DohAnswer[]> {
  const baseUrl = process.env.DNS_RESOLVER_URL ?? "https://cloudflare-dns.com/dns-query";
  const url = `${baseUrl}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH lookup failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as DohResponse;
  if (body.Status !== 0) {
    // NOERROR=0, NXDOMAIN=3, etc. Anything non-zero means no resolution.
    return [];
  }
  return body.Answer ?? [];
}

/**
 * Look up the CNAME target for a domain. Returns the unquoted, trailing-dot-
 * stripped target string, or null if no CNAME exists.
 */
export async function lookupCname(domain: string): Promise<string | null> {
  const answers = await dohLookup(domain, DNS_TYPE_CNAME);
  const cname = answers.find((a) => a.type === DNS_TYPE_CNAME);
  if (!cname) return null;
  return cname.data.replace(/\.$/, "").toLowerCase();
}

/**
 * Look up all TXT records for a domain. Returns the raw string values
 * (unquoted; DoH returns them with double quotes that we strip).
 */
export async function lookupTxt(domain: string): Promise<string[]> {
  const answers = await dohLookup(domain, DNS_TYPE_TXT);
  return answers
    .filter((a) => a.type === DNS_TYPE_TXT)
    .map((a) => a.data.replace(/^"/, "").replace(/"$/, ""));
}
