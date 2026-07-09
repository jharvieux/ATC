// #1653 — the global AI kill switch had two unsynced sources: the admin toggle
// wrote ai_kill_switch_state (which the supervisor reads, fail-closed), while
// the customer-chat and help SSE pre-generation gates read
// platform_settings.ai_kill_switch_engaged — which nothing ever wrote. An admin
// global pause therefore never engaged those streaming pre-gates.
//
// These tests pin the fix: the admin toggle now writes BOTH sources in its
// audited operation, so pausing/resuming drives platform_settings.ai_kill_
// switch_engaged (the value the chat/help gates check as `=== true`) in step
// with the state table. A regression that drops the platform_settings write
// re-opens the streaming pre-gate escape.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; op: string; payload: unknown; onConflict?: string }>,
  settingUpsertError: null as { message: string } | null,
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-user-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown) => Promise<unknown>,
  ) => {
    const db = {
      from: (table: string) => ({
        update: (payload: unknown) => {
          h.writes.push({ table, op: "update", payload });
          return {
            eq: () => ({
              select: () => ({
                single: async () => ({
                  data: { id: 1, ...(payload as Record<string, unknown>) },
                  error: null,
                }),
              }),
            }),
          };
        },
        upsert: async (payload: unknown, options: { onConflict?: string }) => {
          h.writes.push({ table, op: "upsert", payload, onConflict: options?.onConflict });
          return { error: h.settingUpsertError };
        },
      }),
    };
    return fn(db);
  },
}));

import { POST } from "@/app/api/admin/ai-kill-switch/route";

function req(body: unknown): Request {
  return new Request("https://app.example.com/api/admin/ai-kill-switch", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer admin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.writes = [];
  h.settingUpsertError = null;
});

describe("POST /api/admin/ai-kill-switch — drives both kill-switch sources (#1653)", () => {
  it("pause writes ai_kill_switch_state.global_paused=true AND platform_settings.ai_kill_switch_engaged=true", async () => {
    const res = await POST(req({ paused: true, reason: "incident-42" }));
    expect(res.status).toBe(200);

    const stateWrite = h.writes.find((w) => w.table === "ai_kill_switch_state");
    expect((stateWrite?.payload as { global_paused: boolean }).global_paused).toBe(true);

    const settingWrite = h.writes.find((w) => w.table === "platform_settings");
    expect(settingWrite, "admin toggle must write platform_settings — the chat/help gate source").toBeTruthy();
    expect(settingWrite?.op).toBe("upsert");
    expect(settingWrite?.onConflict).toBe("key");
    const payload = settingWrite?.payload as { key: string; value: unknown };
    expect(payload.key).toBe("ai_kill_switch_engaged");
    // The gates check `value === true`; a boolean (JSONB true), not a string.
    expect(payload.value).toBe(true);
  });

  it("resume writes false to BOTH sources", async () => {
    const res = await POST(req({ paused: false }));
    expect(res.status).toBe(200);
    const settingWrite = h.writes.find((w) => w.table === "platform_settings");
    expect((settingWrite?.payload as { value: unknown }).value).toBe(false);
    const stateWrite = h.writes.find((w) => w.table === "ai_kill_switch_state");
    expect((stateWrite?.payload as { global_paused: boolean }).global_paused).toBe(false);
  });

  it("fails the whole operation (500) if the platform_settings write errors — no silent half-toggle", async () => {
    h.settingUpsertError = { message: "unique violation" };
    const res = await POST(req({ paused: true }));
    expect(res.status).toBe(500);
  });

  it("rejects a non-boolean paused with 400", async () => {
    const res = await POST(req({ paused: "yes" }));
    expect(res.status).toBe(400);
    expect(h.writes).toHaveLength(0);
  });
});
