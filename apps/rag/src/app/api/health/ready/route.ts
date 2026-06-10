// §26.9 — RAG readiness probe.
//
// Liveness (/api/health) is shallow — just proves the process is alive.
// Readiness checks actual dependency reachability without coupling liveness
// to Redis (a Redis flap would otherwise cause load-balancer restarts).
//
// Used by the main app's vendor-health-probe to record:
//   upstash     — Redis ping round-trip
//   rag         — this endpoint itself being reachable (probe records "rag" down
//                 if it can't reach the URL at all)
//   supabase_rag — RAG Supabase project auth health

import { NextResponse } from "next/server";
import { getRedis } from "@/lib/redis/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [redisResult, supabaseResult] = await Promise.allSettled([
    getRedis().ping(),
    fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/auth/v1/health`, {
      signal: AbortSignal.timeout(5000),
    }),
  ]);

  const redis = redisResult.status === "fulfilled" && redisResult.value === "PONG" ? "ok" : "down";
  const supabaseStatus =
    supabaseResult.status === "fulfilled" && supabaseResult.value.ok ? "ok" : "down";

  const allOk = redis === "ok" && supabaseStatus === "ok";
  return NextResponse.json(
    { redis, supabase_rag: supabaseStatus },
    { status: allOk ? 200 : 503 },
  );
}
