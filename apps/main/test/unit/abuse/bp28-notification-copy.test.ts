// BP28 — verify the abuse_notification_copy seed migration ships copy for
// every (dimension, state) pair the consumer queries.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(
  __dirname,
  "../../../supabase/migrations/20260607000000_abuse_dashboard.sql",
);

const REQUIRED_KEYS = [
  "ai_cost.soft1", "ai_cost.soft2", "ai_cost.hard",
  "chat_volume.soft1", "chat_volume.soft2", "chat_volume.hard",
  "email_volume.soft1", "email_volume.soft2", "email_volume.hard",
  "group_invite.soft1", "group_invite.soft2", "group_invite.hard",
  "rag_cap.approaching", "rag_cap.at_cap",
];

describe("BP28 — abuse_notification_copy seed", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf8");

  it.each(REQUIRED_KEYS)("ships copy for %s", (key) => {
    expect(sql).toContain(`"${key}"`);
  });

  it("each seeded key has both subject_template and body_intro", () => {
    // Crude but effective: the seed block uses a JSONB literal. Each key
    // should appear above a subject_template and body_intro field.
    for (const key of REQUIRED_KEYS) {
      const idx = sql.indexOf(`"${key}"`);
      expect(idx).toBeGreaterThan(-1);
      const snippet = sql.slice(idx, idx + 600);
      expect(snippet).toContain("subject_template");
      expect(snippet).toContain("body_intro");
    }
  });

  it("uses ON CONFLICT DO NOTHING so a re-run does not clobber operator edits", () => {
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
  });
});
