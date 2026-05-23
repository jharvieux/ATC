// §23.6 — Email rate limit tests.
// Verifies transactional/pre_cruise bypass, marketing monthly cap, and
// travel_news weekly cap.

import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "@/lib/email/rate-limit";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockDb(count: number) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => ({
                not: vi.fn().mockResolvedValue({ data: Array(count).fill({ id: "x" }), error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("checkRateLimit — §23.6", () => {
  it("transactional is always allowed", async () => {
    const result = await checkRateLimit({
      db: mockDb(999),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "transactional",
    });
    expect(result.allowed).toBe(true);
  });

  it("pre_cruise is always allowed (bound to schedule)", async () => {
    const result = await checkRateLimit({
      db: mockDb(999),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "pre_cruise",
    });
    expect(result.allowed).toBe(true);
  });

  it("group_invitation is always allowed (enforced separately)", async () => {
    const result = await checkRateLimit({
      db: mockDb(999),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "group_invitation",
    });
    expect(result.allowed).toBe(true);
  });

  it("marketing: 3 sent this month → allowed", async () => {
    const result = await checkRateLimit({
      db: mockDb(3),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "marketing",
    });
    expect(result.allowed).toBe(true);
  });

  it("marketing: 4 sent this month → blocked", async () => {
    const result = await checkRateLimit({
      db: mockDb(4),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "marketing",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("marketing_monthly_limit_reached");
  });

  it("travel_news: 0 sent this week → allowed", async () => {
    const result = await checkRateLimit({
      db: mockDb(0),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "travel_news",
    });
    expect(result.allowed).toBe(true);
  });

  it("travel_news: 1 sent this week → blocked", async () => {
    const result = await checkRateLimit({
      db: mockDb(1),
      tenant_id: "t1",
      to_email: "test@example.com",
      category: "travel_news",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("travel_news_weekly_limit_reached");
  });
});
