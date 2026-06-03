// §24.6 — persona resolution precedence for a chat turn.
//
// The regression this pins: the chat handler used to load the conversation's
// active_persona_id and then ignore it (`void conversationActivePersonaId`),
// so a customer who switched personas kept getting the default/body persona on
// every later turn. These tests fail if that ordering is ever inverted, or if
// the lookup stops using the id, or if a transient read error is allowed to
// hard-fail instead of falling through.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveActivePersonaSlug } from "@/lib/personas/resolve-active-persona-slug";
import { DEFAULT_PERSONA_SLUG } from "@/lib/personas/build-system-prompt";

type QueryResult = { data: unknown; error: { message: string } | null };

// Mocks `from("personas").select("slug").eq("id", val).maybeSingle()` and
// records each .eq(col, val) + how many times personas was queried, so a test
// can assert we look up by id AND that no read happens when there's no
// active_persona_id.
function makeDb(responder: () => QueryResult) {
  const eqCalls: Array<[string, unknown]> = [];
  let personasReads = 0;
  const db = {
    from(table: string) {
      if (table !== "personas") throw new Error(`unexpected table in test mock: ${table}`);
      personasReads += 1;
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return builder;
        },
        maybeSingle: async () => responder(),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, eqCalls, reads: () => personasReads };
}

const SWITCHED_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("resolveActivePersonaSlug (§24.6 precedence)", () => {
  it("a switched persona wins over the request body (the #606 fix)", async () => {
    const { db, eqCalls } = makeDb(() => ({ data: { slug: "switched-slug" }, error: null }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: SWITCHED_ID,
      requestedSlug: "requested-slug",
    });

    expect(slug).toBe("switched-slug");
    // The id — not the slug — is what resolves the switched persona.
    expect(eqCalls).toContainEqual(["id", SWITCHED_ID]);
  });

  it("the switched persona wins even when the body sends no slug", async () => {
    const { db } = makeDb(() => ({ data: { slug: "switched-slug" }, error: null }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: SWITCHED_ID,
      requestedSlug: null,
    });

    expect(slug).toBe("switched-slug");
  });

  it("falls through to the body slug when active_persona_id resolves to nothing", async () => {
    const { db } = makeDb(() => ({ data: null, error: null }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: SWITCHED_ID,
      requestedSlug: "requested-slug",
    });

    expect(slug).toBe("requested-slug");
  });

  it("a read error is best-effort: warns and falls through, never hard-fails", async () => {
    const { db } = makeDb(() => ({ data: null, error: { message: "connection reset" } }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: SWITCHED_ID,
      requestedSlug: "requested-slug",
    });

    expect(slug).toBe("requested-slug");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("uses the body slug WITHOUT any DB read when there's no active_persona_id", async () => {
    const { db, reads } = makeDb(() => ({ data: { slug: "switched-slug" }, error: null }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: null,
      requestedSlug: "requested-slug",
    });

    expect(slug).toBe("requested-slug");
    expect(reads()).toBe(0);
  });

  it("falls back to DEFAULT_PERSONA_SLUG when neither a switch nor a body slug is present", async () => {
    const { db, reads } = makeDb(() => ({ data: null, error: null }));

    const slug = await resolveActivePersonaSlug(db, {
      activePersonaId: null,
      requestedSlug: null,
    });

    expect(slug).toBe(DEFAULT_PERSONA_SLUG);
    expect(reads()).toBe(0);
  });
});
