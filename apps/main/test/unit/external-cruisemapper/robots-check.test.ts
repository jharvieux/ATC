// BP36 §33.5 — robots.txt parser + allow/disallow tests.

import { describe, expect, it } from "vitest";
import { _parseRobotsForTests, _isAllowedForTests } from "../../../src/lib/external/cruisemapper/robots-check";

const ROBOTS_BASIC = `
User-agent: *
Disallow: /admin/
Allow: /admin/public/

User-agent: BadBot
Disallow: /

User-agent: AITravelConcierge
Allow: /ships/
Allow: /ports/
Disallow: /private/
`;

describe("parseRobots + isAllowed", () => {
  const parsed = _parseRobotsForTests(ROBOTS_BASIC);

  it("allows our user-agent on /ships/* and /ports/*", () => {
    expect(_isAllowedForTests(parsed, "AITravelConcierge/1.0", "/ships/symphony")).toBe(true);
    expect(_isAllowedForTests(parsed, "AITravelConcierge/1.0", "/ports/miami")).toBe(true);
  });

  it("disallows our user-agent on /private/", () => {
    expect(_isAllowedForTests(parsed, "AITravelConcierge/1.0", "/private/whatever")).toBe(false);
  });

  it("falls back to * rules when no specific agent matches", () => {
    expect(_isAllowedForTests(parsed, "SomeUnknownBot/1.0", "/admin/")).toBe(false);
    expect(_isAllowedForTests(parsed, "SomeUnknownBot/1.0", "/admin/public/page")).toBe(true);
  });

  it("disallow everything to BadBot", () => {
    expect(_isAllowedForTests(parsed, "BadBot", "/anything")).toBe(false);
  });

  it("when no rules apply at all, defaults to allow", () => {
    const empty = _parseRobotsForTests("# only comments\n# no rules");
    expect(_isAllowedForTests(empty, "AITravelConcierge", "/ships/foo")).toBe(true);
  });

  it("ignores comments + blank lines without crashing", () => {
    const messy = _parseRobotsForTests(`
# top comment

User-agent: *  # inline comment OK

Disallow: /xx/
`);
    expect(_isAllowedForTests(messy, "Whatever", "/xx/y")).toBe(false);
    expect(_isAllowedForTests(messy, "Whatever", "/ok")).toBe(true);
  });
});
