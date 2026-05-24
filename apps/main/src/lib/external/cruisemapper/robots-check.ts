// BP36 §33.5 — robots.txt enforcement for the CruiseMapper DIY scraper.
//
// Minimal compliant parser (Allow/Disallow under matching User-agent
// groups). Wildcard `*` is supported in both User-agent and paths.
// No installed dependency (CLAUDE.md: runtime deps require explicit
// approval; the robots.txt grammar is small enough to handle inline).
//
// 24-hour cache. On fetch failure we conservatively DISALLOW — better
// to no-op the run than to hammer the site without authoritative rules.

import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";

interface ParsedRobots {
  groups: Array<{ agents: string[]; allows: string[]; disallows: string[] }>;
}

interface CacheEntry { parsed: ParsedRobots; fetchedAt: number }

let cache: CacheEntry | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

function parseRobots(text: string): ParsedRobots {
  const groups: ParsedRobots["groups"] = [];
  let current: { agents: string[]; allows: string[]; disallows: string[] } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (field === "user-agent") {
      // A User-agent line that follows allow/disallow opens a new group.
      if (!current || current.allows.length > 0 || current.disallows.length > 0) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value);
    } else if (current) {
      if (field === "allow")    current.allows.push(value);
      if (field === "disallow") current.disallows.push(value);
    }
  }
  return { groups };
}

function userAgentMatches(group: string[], ua: string): boolean {
  const uaLower = ua.toLowerCase();
  return group.some((a) => a === "*" || uaLower.includes(a.toLowerCase()));
}

/** Compile a robots.txt rule pattern to a regex (supports * and $). */
function ruleToRegex(rule: string): RegExp {
  if (!rule) return /^$/;
  let re = "";
  for (let i = 0; i < rule.length; i += 1) {
    const ch = rule[i];
    if (ch === "*") {
      re += ".*";
    } else if (ch === "$" && i === rule.length - 1) {
      re += "$";
    } else {
      // Escape regex metas
      re += ch && /[.+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch ?? "";
    }
  }
  return new RegExp(`^${re}`);
}

function ruleMatches(rule: string, path: string): boolean {
  return ruleToRegex(rule).test(path);
}

/** True iff the userAgent is allowed to fetch the URL's path. */
export function isAllowed(parsed: ParsedRobots, userAgent: string, urlPath: string): boolean {
  // Find the most-specific matching group: prefer explicit UA match over `*`.
  const matching = parsed.groups.filter((g) => userAgentMatches(g.agents, userAgent));
  const explicit = matching.find((g) => g.agents.some((a) => a !== "*" && userAgent.toLowerCase().includes(a.toLowerCase())));
  const star = matching.find((g) => g.agents.includes("*"));
  const group = explicit ?? star;
  if (!group) return true; // no applicable rules → allowed by default

  // Longest-match-wins between Allow and Disallow per Google's modern semantics.
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const a of group.allows) {
    if (ruleMatches(a, urlPath) && a.length > bestAllow) bestAllow = a.length;
  }
  for (const d of group.disallows) {
    if (d === "") continue; // empty Disallow == allow everything
    if (ruleMatches(d, urlPath) && d.length > bestDisallow) bestDisallow = d.length;
  }
  if (bestDisallow === -1) return true;
  if (bestAllow >= bestDisallow) return true;
  return false;
}

async function fetchRobots(baseUrl: string): Promise<ParsedRobots | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/robots.txt`, {
      headers: { "User-Agent": process.env.CRUISEMAPPER_DIY_USER_AGENT ?? "AITravelConcierge/1.0" },
    });
    if (!res.ok) return null;
    return parseRobots(await res.text());
  } catch {
    return null;
  }
}

/**
 * Returns true iff the given URL is allowed for our User-Agent.
 * Caches the parsed robots.txt for 24h. On fetch failure → conservatively
 * disallows AND fires a high-severity operator alert.
 */
export async function checkRobotsAllowed(url: string): Promise<boolean> {
  const ua = process.env.CRUISEMAPPER_DIY_USER_AGENT ?? "";
  if (!ua) return false; // policy: never scrape without identifying UA

  const base = process.env.CRUISEMAPPER_DIY_BASE_URL ?? "https://www.cruisemapper.com";
  const now = Date.now();
  if (!cache || now - cache.fetchedAt > TTL_MS) {
    const parsed = await fetchRobots(base);
    if (!parsed) {
      await sendOperatorAlert({
        severity: "high",
        signal: "cruisemapper_robots_fetch_failed",
        detail: `Could not fetch ${base}/robots.txt. DIY scraper will conservatively block until next attempt.`,
        payload: {},
      });
      return false;
    }
    cache = { parsed, fetchedAt: now };
  }

  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return false; }
  return isAllowed(cache.parsed, ua, parsedUrl.pathname + parsedUrl.search);
}

/** Test-only helpers. */
export function _setRobotsCacheForTests(parsed: ParsedRobots | null): void {
  cache = parsed ? { parsed, fetchedAt: Date.now() } : null;
}
export const _parseRobotsForTests = parseRobots;
export const _isAllowedForTests = isAllowed;
