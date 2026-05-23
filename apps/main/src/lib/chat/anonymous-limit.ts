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

async function getCountSince(
  db: SupabaseClient,
  tenant_id: string,
  identifier_type: "session" | "ip" | "fingerprint",
  identifier_value: string,
  since: string | null,
): Promise<number> {
  if (!identifier_value) return 0;
  let q = db
    .from("anonymous_chat_counters")
    .select("current_count, last_message_at")
    .eq("tenant_id", tenant_id)
    .eq("identifier_type", identifier_type)
    .eq("identifier_value", identifier_value);
  if (since) q = q.gte("last_message_at", since);
  const { data } = await q.maybeSingle();
  return (data as { current_count?: number } | null)?.current_count ?? 0;
}

export async function checkAnonLimit(
  db: SupabaseClient,
  input: AnonLimitInput,
): Promise<AnonLimitResult> {
  const caps = capsFromEnv(Boolean(input.under_abuse));

  // Session counter is lifetime-of-row (no time window). IP and fingerprint
  // are 24h rolling.
  const sessionCount = await getCountSince(
    db, input.tenant_id, "session", input.session_id, null,
  );
  if (sessionCount >= caps.session) {
    return { allowed: false, hit_identifier_type: "session" };
  }

  const since24h = TWENTY_FOUR_HOURS_AGO();
  const ipCount = input.ip
    ? await getCountSince(db, input.tenant_id, "ip", input.ip, since24h)
    : 0;
  if (input.ip && ipCount >= caps.ip) {
    return { allowed: false, hit_identifier_type: "ip" };
  }

  const fpCount = input.fingerprint
    ? await getCountSince(db, input.tenant_id, "fingerprint", input.fingerprint, since24h)
    : 0;
  if (input.fingerprint && fpCount >= caps.fingerprint) {
    return { allowed: false, hit_identifier_type: "fingerprint" };
  }

  return { allowed: true };
}

// Increment all three identifier counters atomically(ish). Service-role db.
// Upserts on (identifier_type, identifier_value, tenant_id) PK.
export async function incrementAnonCounters(
  db: SupabaseClient,
  input: AnonLimitInput,
): Promise<void> {
  const now = new Date().toISOString();
  const ids: Array<["session" | "ip" | "fingerprint", string]> = [
    ["session", input.session_id],
  ];
  if (input.ip) ids.push(["ip", input.ip]);
  if (input.fingerprint) ids.push(["fingerprint", input.fingerprint]);

  for (const [type, value] of ids) {
    if (!value) continue;
    // Read-then-write because PostgREST UPSERT can't ON CONFLICT increment.
    const { data: existing } = await db
      .from("anonymous_chat_counters")
      .select("current_count")
      .eq("tenant_id", input.tenant_id)
      .eq("identifier_type", type)
      .eq("identifier_value", value)
      .maybeSingle();
    const current = (existing as { current_count?: number } | null)?.current_count ?? 0;
    if (existing) {
      await db
        .from("anonymous_chat_counters")
        .update({ current_count: current + 1, last_message_at: now })
        .eq("tenant_id", input.tenant_id)
        .eq("identifier_type", type)
        .eq("identifier_value", value);
    } else {
      await db.from("anonymous_chat_counters").insert({
        tenant_id: input.tenant_id,
        identifier_type: type,
        identifier_value: value,
        current_count: 1,
        first_message_at: now,
        last_message_at: now,
      });
    }
  }
}

// Record the limit-hit timestamp on the most-restrictive identifier, then
// check whether 3+ sessions from the same IP have hit the cap within 24h —
// emit the §24.8 anonymous_chat_burst_detected event for BP27 to consume.
export async function recordLimitHitAndCheckBurst(
  db: SupabaseClient,
  input: AnonLimitInput & { hit_identifier_type: "session" | "ip" | "fingerprint" },
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from("anonymous_chat_counters")
    .update({ limit_hit_at: now })
    .eq("tenant_id", input.tenant_id)
    .eq("identifier_type", input.hit_identifier_type)
    .eq("identifier_value",
      input.hit_identifier_type === "session" ? input.session_id
        : input.hit_identifier_type === "ip" ? input.ip
        : input.fingerprint);

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
