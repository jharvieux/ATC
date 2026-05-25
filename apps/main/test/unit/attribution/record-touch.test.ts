// BP35 §35.4 — Touch writer tests.

import { describe, expect, it } from "vitest";
import { recordIdentificationTouch } from "@/lib/attribution/record-touch";
import { emptyAttributionPayload } from "@/lib/attribution/types";

function fakeSvc(opts?: { insertId?: string; insertError?: string; updateError?: string }) {
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; payload: Record<string, unknown>; where: unknown }> = [];
  const svc = {
    inserts,
    updates,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    impl: {
      from: (table: string) => ({
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({
            single: () => {
              inserts.push({ table, payload });
              if (opts?.insertError) {
                return Promise.resolve({ data: null, error: { message: opts.insertError } });
              }
              return Promise.resolve({ data: { id: opts?.insertId ?? "touch-1" }, error: null });
            },
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: (_col: string, val: unknown) => {
            updates.push({ table, payload, where: val });
            return Promise.resolve({
              data: null,
              error: opts?.updateError ? { message: opts.updateError } : null,
            });
          },
        }),
      }),
    } as any,
  };
  return svc;
}

describe("recordIdentificationTouch", () => {
  it("inserts a touch row + populates first_touch_* for new contact", async () => {
    const f = fakeSvc();
    const r = await recordIdentificationTouch(
      {
        tenant_id: "t1",
        contact_id: "c1",
        is_new_contact: true,
        source_origin: "utm_parsed",
        payload: {
          utm_source: "facebook",
          utm_medium: "social",
          utm_campaign: "wave",
          utm_content: null,
          utm_term: null,
          referrer_url: "https://fb.com/",
          landing_path: "/landing",
          channel: "social",
          manual_label: null,
          manual_category: null,
        },
      },
      f.impl,
    );
    expect(r).toEqual({ ok: true, touch_id: "touch-1" });
    expect(f.inserts.find((i) => i.table === "attribution_touches")).toBeDefined();
    const update = f.updates.find((u) => u.table === "contacts");
    expect(update).toBeDefined();
    expect(update!.payload.first_touch_utm_campaign).toBe("wave");
    expect(update!.payload.first_touch_channel).toBe("social");
  });

  it("inserts a touch row but does NOT touch first_touch_* for returning contact", async () => {
    const f = fakeSvc();
    const r = await recordIdentificationTouch(
      {
        tenant_id: "t1",
        contact_id: "c1",
        is_new_contact: false,
        source_origin: "utm_parsed",
        payload: {
          utm_source: "google",
          utm_medium: "cpc",
          utm_campaign: "fall",
          utm_content: null,
          utm_term: null,
          referrer_url: null,
          landing_path: "/x",
          channel: "search",
          manual_label: null,
          manual_category: null,
        },
      },
      f.impl,
    );
    expect(r.ok).toBe(true);
    expect(f.inserts.find((i) => i.table === "attribution_touches")).toBeDefined();
    expect(f.updates.find((u) => u.table === "contacts")).toBeUndefined();
  });

  it("rejects agent_edit on new contact (caller bug)", async () => {
    const f = fakeSvc();
    const r = await recordIdentificationTouch(
      {
        tenant_id: "t1",
        contact_id: "c1",
        is_new_contact: true,
        source_origin: "agent_edit",
        editor_user_id: "u1",
        payload: emptyAttributionPayload(),
      },
      f.impl,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("agent_edit_on_new_contact");
  });

  it("falls through to empty payload + direct channel when null payload", async () => {
    const f = fakeSvc();
    await recordIdentificationTouch(
      {
        tenant_id: "t1",
        contact_id: "c1",
        is_new_contact: true,
        source_origin: "utm_parsed",
        payload: null,
      },
      f.impl,
    );
    const insert = f.inserts.find((i) => i.table === "attribution_touches");
    expect(insert!.payload.channel).toBe("direct");
    expect(insert!.payload.utm_source).toBeNull();
  });

  it("returns error if insert fails", async () => {
    const f = fakeSvc({ insertError: "db down" });
    const r = await recordIdentificationTouch(
      {
        tenant_id: "t1",
        contact_id: "c1",
        is_new_contact: false,
        source_origin: "utm_parsed",
        payload: emptyAttributionPayload(),
      },
      f.impl,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("db down");
  });
});
