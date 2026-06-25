// §24.8 — Anonymous chat three-identifier rate limit.
//
// Caller passes (tenant_id, session_id, ip, fingerprint). We query the
// per-identifier current_count from anonymous_chat_counters and compare to
// the configured caps. Most-restrictive identifier wins; the wall message
// MUST NOT reveal which identifier hit (defense-in-depth — see §24.8).
//
// Service-role only. All RLS policies on anonymous_chat_counters are
// FOR ... USING (FALSE); the table is read/written via the service role.

import type { SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "@/inngest/client";
import { safeAwait } from "@/lib/db/safe-mutation";

export type AnonLimitInput = {
  tenant_id: string;
  session_id: string;
  ip: string;        // may be ""
  fingerprint: string;
  under_abuse?: boolean;
};

export type AnonLimitResult = {
  allowed: boolean;
  // Internal-only; UI must NOT reveal which identifier hit.
  hit_identifier_type?: "session" | "ip" | "fingerprint";
};

type CapsBundle = {
  session: number;
  ip: number;
  fingerprint: number;
};

export function capsFromEnv(under_abuse: boolean): CapsBundle {
  if (under_abuse) {
    return {
      session: Number(process.env.ANON_CHAT_LIMIT_PER_SESSION_UNDER_ABUSE ?? 2),
      ip:      Number(process.env.ANON_CHAT_LIMIT_PER_IP_UNDER_ABUSE ?? 5),
      fingerprint: Number(process.env.ANON_CHAT_LIMIT_PER_FINGERPRINT_UNDER_ABUSE ?? 3),
    };
  }
  return {
    session: Number(process.env.ANON_CHAT_LIMIT_PER_SESSION ?? 5),
    ip:      Number(process.env.ANON_CHAT_LIMIT_PER_IP_24H ?? 15),
    fingerprint: Number(process.env.ANON_CHAT_LIMIT_PER_FINGERPRINT_24H ?? 10),
  };
}

const TWENTY_FOUR_HOURS_AGO = () =>
  new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

async function incrementAnonCounter(
  db: SupabaseClient,
  tenant_id: string,
  identifier_type: "session" | "ip" | "fingerprint",
  identifier_value: string,
  window_seconds: number | null,
): Promise<number> {
  // Atomic consume-then-check: the RPC increments and RETURNs the post-increment
  // count in one statement (rolling-window reset folded in for windowed
  // identifiers). Returns 0 for an absent identifier so the caller skips it.
  if (!identifier_value) return 0;
  const { data, error } = await db.rpc("increment_anon_chat_counter", {
    p_tenant_id: tenant_id,
    p_identifier_type: identifier_type,
    p_identifier_value: identifier_value,
    p_window_seconds: window_seconds,
  });
  if (error) throw new Error(`increment_anon_chat_counter failed: ${error.message}`);
  const count = Number(data);
  if (!Number.isFinite(count)) {
    throw new Error("increment_anon_chat_counter returned a non-numeric count");
  }
  return count;
}

const TWENTY_FOUR_HOURS_SECONDS = 24 * 60 * 60;

// F-sm-02 (#1377): consume-then-check across all three identifiers. The old
// path read all counters (checkAnonLimit) and only later wrote them
// (incrementAnonCounters) — a TOCTOU window where N parallel requests on a
// fresh session/IP/fingerprint all passed the gate and reached the paid model.
//
// Now each identifier is incremented atomically up front and the decision is
// made against the returned count, so exactly `cap` requests cross each
// boundary. Session is lifetime (null window); IP and fingerprint are 24h
// rolling. Most-restrictive identifier wins; the result MUST NOT reveal which
// one hit (§24.8). All present identifiers are incremented even on a block
// (consume-then-check) — that only tightens the wall.
export async function enforceAnonLimit(
  db: SupabaseClient,
  input: AnonLimitInput,
): Promise<AnonLimitResult> {
  const caps = capsFromEnv(Boolean(input.under_abuse));

  // Priority order = most-restrictive-first, so the first over-cap identifier
  // is the reported one (matches the prior session→ip→fingerprint precedence).
  const identifiers: Array<{
    type: "session" | "ip" | "fingerprint";
    value: string;
    cap: number;
    window: number | null;
  }> = [
    { type: "session", value: input.session_id, cap: caps.session, window: null },
    { type: "ip", value: input.ip, cap: caps.ip, window: TWENTY_FOUR_HOURS_SECONDS },
    { type: "fingerprint", value: input.fingerprint, cap: caps.fingerprint, window: TWENTY_FOUR_HOURS_SECONDS },
  ];

  let hit: "session" | "ip" | "fingerprint" | undefined;
  for (const id of identifiers) {
    if (!id.value) continue;
    const count = await incrementAnonCounter(db, input.tenant_id, id.type, id.value, id.window);
    // post-increment count > cap ⇒ this request is the (cap+1)-th ⇒ blocked.
    if (count > id.cap && !hit) hit = id.type;
  }

  return hit ? { allowed: false, hit_identifier_type: hit } : { allowed: true };
}

// Record the limit-hit timestamp on the most-restrictive identifier, then
// check whether 3+ sessions from the same IP have hit the cap within 24h —
// emit the §24.8 anonymous_chat_burst_detected event for BP27 to consume.
export async function recordLimitHitAndCheckBurst(
  db: SupabaseClient,
  input: AnonLimitInput & { hit_identifier_type: "session" | "ip" | "fingerprint" },
): Promise<void> {
  const now = new Date().toISOString();
  await safeAwait(db
    .from("anonymous_chat_counters")
    .update({ limit_hit_at: now })
    .eq("tenant_id", input.tenant_id)
    .eq("identifier_type", input.hit_identifier_type)
    .eq("identifier_value",
      input.hit_identifier_type === "session" ? input.session_id
        : input.hit_identifier_type === "ip" ? input.ip
        : input.fingerprint), "anonymous_chat_counters.update");

  // Burst detection: 3+ rows with the same IP that have all hit the limit
  // in the last 24h.
  if (input.ip) {
    const since = TWENTY_FOUR_HOURS_AGO();
    const { data } = await db
      .from("anonymous_chat_counters")
      .select("identifier_value, limit_hit_at")
      .eq("tenant_id", input.tenant_id)
      .eq("identifier_type", "ip")
      .eq("identifier_value", input.ip)
      .gte("limit_hit_at", since);
    const hitCount = Array.isArray(data) ? data.length : 0;
    if (hitCount >= 3) {
      // §24.8: emit for §27 abuse signal consumer. Consumer is TODO(part-6).
      await inngest.send({
        name: "chat.anonymous_chat_burst_detected",
        data: { tenant_id: input.tenant_id, ip: input.ip },
      });
    }
  }
}
