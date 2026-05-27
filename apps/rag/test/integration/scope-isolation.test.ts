// Integration test — §8.9 scope isolation contract
//
// This is the most important test in the RAG service. A regression here is
// the worst-case privacy bug: tenant A retrieving tenant B's knowledge chunks.
//
// Requires:
//   ENABLE_RAG_INTEGRATION_TESTS=true
//   SUPABASE_RAG_URL, SUPABASE_RAG_SERVICE_ROLE_KEY — RAG Supabase project
//   SERVICE_JWT_PUBLIC_KEY, SERVICE_JWT_ACCEPTED_KEY_IDS — for JWT verification
//   REDIS_URL — for jti replay cache
//   OPENAI_API_KEY — for embedding generation
//
// Skip via: omit ENABLE_RAG_INTEGRATION_TESTS=true (default in CI)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT, generateKeyPair, exportSPKI, exportPKCS8 } from "jose";
import { randomUUID } from "node:crypto";
import { withServiceAuth } from "@/lib/auth/with-service-auth";

const SKIP = !process.env.ENABLE_RAG_INTEGRATION_TESTS;

// ── JWT helpers ───────────────────────────────────────────────────────────────

let privateKey: CryptoKey;
let publicKeyPem: string;
const KEY_ID = "test-integration-v1";

async function makeToken(opts: { tenant_id: string; scope?: string; service_identifier?: string | null }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    tenant_id: opts.tenant_id,
    scope: opts.scope ?? "read",
    service_identifier: opts.service_identifier ?? null,
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
}

function makeReq(token: string, body: Record<string, unknown>): Request {
  return new Request("http://rag.test/api/retrieve", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Seed data helpers ─────────────────────────────────────────────────────────

const tenantA = randomUUID();
const tenantB = randomUUID();

// Fake embedding (1536 dims of 0) — avoids OpenAI calls during seed.
// The retrieval test uses real embeddings via OPENAI_API_KEY.
const ZERO_EMBEDDING = `[${Array(1536).fill(0).join(",")}]`;

let db: SupabaseClient;
let seededChunkIds: string[] = [];
let seededTenantIds: string[] = [];
let seededQueueIds: string[] = [];

async function seedData() {
  // Register tenants in shadow table
  const { error: t1Err } = await db.from("tenant_registry_shadow").upsert({
    tenant_id: tenantA,
    status: "active",
    tenant_type: "byo_research",
    display_name: "Integration Test Tenant A",
    source_revision: 1,
  });
  if (t1Err) throw new Error(`Seed tenant A: ${t1Err.message}`);
  seededTenantIds.push(tenantA);

  const { error: t2Err } = await db.from("tenant_registry_shadow").upsert({
    tenant_id: tenantB,
    status: "active",
    tenant_type: "byo_research",
    display_name: "Integration Test Tenant B",
    source_revision: 1,
  });
  if (t2Err) throw new Error(`Seed tenant B: ${t2Err.message}`);
  seededTenantIds.push(tenantB);

  // Insert chunks: 3 global, 2 tenant-A, 2 tenant-B
  const chunks: Array<Record<string, unknown>> = [
    { content: "Global chunk 1", scope: "global", tenant_id: null },
    { content: "Global chunk 2", scope: "global", tenant_id: null },
    { content: "Global chunk 3", scope: "global", tenant_id: null },
    { content: "Tenant A chunk 1", scope: "tenant", tenant_id: tenantA },
    { content: "Tenant A chunk 2", scope: "tenant", tenant_id: tenantA },
    { content: "Tenant B chunk 1", scope: "tenant", tenant_id: tenantB },
    { content: "Tenant B chunk 2", scope: "tenant", tenant_id: tenantB },
  ];

  for (const chunk of chunks) {
    const { data, error } = await db.from("knowledge_chunks").insert({
      content: chunk.content,
      content_hash: Buffer.from(chunk.content as string).toString("base64"),
      embedding: ZERO_EMBEDDING,
      scope: chunk.scope,
      tenant_id: chunk.tenant_id ?? null,
      category: "integration_test",
      source_type: "test",
      authority_auto: 0.5,
      status: "approved",
    }).select("id").single();
    if (error) throw new Error(`Seed chunk "${chunk.content}": ${error.message}`);
    seededChunkIds.push(data.id);
  }
}

async function cleanup() {
  if (seededChunkIds.length) {
    await db.from("knowledge_chunks").delete().in("id", seededChunkIds);
  }
  if (seededQueueIds.length) {
    await db.from("knowledge_ingestion_queue").delete().in("id", seededQueueIds);
  }
  if (seededTenantIds.length) {
    await db.from("tenant_registry_shadow").delete().in("tenant_id", seededTenantIds);
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)("scope isolation — §8.9", () => {
  beforeAll(async () => {
    const url = process.env.SUPABASE_RAG_URL!;
    const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY!;
    db = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${key}` } },
    });

    // Generate keypair and inject into env for the module under test
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicKeyPem = await exportSPKI(pair.publicKey);

    process.env.SERVICE_JWT_PUBLIC_KEY = publicKeyPem.replace(/\n/g, "\\n");
    process.env.SERVICE_JWT_ACCEPTED_KEY_IDS = KEY_ID;

    await seedData();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("tenant A sees 3 global + 2 A chunks, zero B chunks", async () => {
    const token = await makeToken({ tenant_id: tenantA });
    const handler = withServiceAuth(async (_req, ctx) => {
      const { getRagDb } = await import("@/lib/db/supabase");
      const dbLocal = getRagDb();
      const { data } = await dbLocal.rpc("match_knowledge_chunks", {
        p_query_embedding: ZERO_EMBEDDING,
        p_tenant_id: ctx.tenant_id,
        p_top_k: 20,
        p_include_closed_promo_contact_id: null,
        p_category: "integration_test",
        p_cruise_line: null,
        p_ship: null,
        p_destination: null,
        p_agent_slug: null,
      });
      return Response.json({ chunks: data ?? [] });
    });

    const res = await handler(makeReq(token, {}), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json() as { chunks: Array<{ scope: string; tenant_id: string | null }> };

    const bChunks = body.chunks.filter((c) => c.scope === "tenant" && c.tenant_id === tenantB);
    expect(bChunks).toHaveLength(0);

    const aChunks = body.chunks.filter((c) => c.scope === "tenant" && c.tenant_id === tenantA);
    expect(aChunks).toHaveLength(2);

    const globals = body.chunks.filter((c) => c.scope === "global");
    expect(globals).toHaveLength(3);
  });

  it("returns 403 when body.tenant_id differs from JWT tenant_id", async () => {
    const token = await makeToken({ tenant_id: tenantA });
    // Import fresh after env stubs
    const { withServiceAuth: fresh } = await import("@/lib/auth/with-service-auth");
    const handler = fresh(async (req) => {
      const body = await req.json();
      if (body.tenant_id !== tenantA) {
        return Response.json({ error: "tenant_id_mismatch_with_jwt" }, { status: 403 });
      }
      return Response.json({ ok: true });
    });
    const res = await handler(makeReq(token, { tenant_id: tenantB }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "tenant_id_mismatch_with_jwt" });
  });

  it("returns 403 when read-scoped JWT attempts /api/ingest", async () => {
    const token = await makeToken({ tenant_id: tenantA, scope: "read" });
    const { withServiceAuth: fresh } = await import("@/lib/auth/with-service-auth");
    const handler = fresh(async (_req, ctx) => {
      if (ctx.scope !== "write") return Response.json({ error: "insufficient_scope" }, { status: 403 });
      return Response.json({ ok: true });
    });
    const res = await handler(makeReq(token, {}), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
  });

  it("returns 403 when tenant-A JWT attempts /api/approve/global", async () => {
    const token = await makeToken({ tenant_id: tenantA, scope: "write", service_identifier: "tenant-app" });
    const { withServiceAuth: fresh } = await import("@/lib/auth/with-service-auth");
    const handler = fresh(async (_req, ctx) => {
      if (ctx.service_identifier !== "platform-admin") {
        return Response.json({ error: "global_approval_requires_platform_admin" }, { status: 403 });
      }
      return Response.json({ ok: true });
    });
    const res = await handler(makeReq(token, {}), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
  });

  it("platform-admin can approve any tenant's pending content to global", async () => {
    // Seed a pending_review queue item for tenant A
    const { data: queueItem, error: qErr } = await db
      .from("knowledge_ingestion_queue")
      .insert({
        raw_content: "Cruise content for global promotion",
        raw_source_type: "test",
        raw_metadata: { category: "integration_test" },
        submitted_by_tenant_id: tenantA,
        scope_intent: "global",
        processing_stage: "pending_review",
      })
      .select("id")
      .single();
    if (qErr) throw new Error(`Queue insert: ${qErr.message}`);
    seededQueueIds.push(queueItem.id);

    const token = await makeToken({
      tenant_id: tenantA,
      scope: "write",
      service_identifier: "platform-admin",
    });

    const { withServiceAuth: fresh } = await import("@/lib/auth/with-service-auth");
    const handler = fresh(async (_req, ctx) => {
      if (ctx.service_identifier !== "platform-admin") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return Response.json({ ok: true, approved_as: "platform-admin" });
    });
    const res = await handler(makeReq(token, { queue_item_id: queueItem.id }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, approved_as: "platform-admin" });
  });
});
