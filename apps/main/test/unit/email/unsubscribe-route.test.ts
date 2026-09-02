import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signHmacJwt } from "@/lib/auth/hmac-jwt";
import { signUnsubscribeToken } from "@/lib/email/unsubscribe-token";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { GET } from "@/app/api/email/unsubscribe/route";

const KEY = "test-hmac-key-32-bytes-long-pad!!";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function request(token?: string): Request {
  const url = new URL("https://app.example.test/api/email/unsubscribe");
  if (token) url.searchParams.set("token", token);
  return new Request(url);
}

function mutatePayload(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("expected compact JWS");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${header}.${Buffer.from(JSON.stringify({ ...decoded, ...changes })).toString("base64url")}.${signature}`;
}

describe("GET /api/email/unsubscribe", () => {
  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = KEY;
    mocks.upsert.mockReset().mockResolvedValue({ data: null, error: null });
    mocks.from.mockReset().mockReturnValue({ upsert: mocks.upsert });
  });

  afterEach(() => {
    delete process.env.INVITATION_TOKEN_HMAC_KEY;
  });

  it("writes the exact tenant and encoded address from a valid signed token", async () => {
    const token = await signUnsubscribeToken({
      email: "traveler+offers@example.test",
      tenant_id: TENANT_ID,
      category: "marketing",
    });

    const response = await GET(request(token));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://app.example.test/email/unsubscribe-confirmed");
    expect(mocks.from).toHaveBeenCalledWith("email_suppressions");
    expect(mocks.upsert).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      email_address: "traveler+offers@example.test",
      reason: "unsubscribe_marketing",
      suppressed_at: expect.any(String),
    }, { onConflict: "tenant_id,email_address,reason" });
  });

  it("does not write when the token is missing", async () => {
    const response = await GET(request());

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not write an expired signed token", async () => {
    const token = await signHmacJwt(
      { email: "traveler@example.test", tenant_id: TENANT_ID, category: "all" },
      new TextEncoder().encode(KEY),
      "unsubscribe",
      Math.floor(Date.now() / 1000) - 60,
    );

    const response = await GET(request(token));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not write a token with a tampered signature", async () => {
    const token = await signUnsubscribeToken({
      email: "traveler@example.test",
      tenant_id: TENANT_ID,
      category: "all",
    });
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    const response = await GET(request(tampered));

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not write when a signed token's tenant or category is mutated", async () => {
    const token = await signUnsubscribeToken({
      email: "traveler@example.test",
      tenant_id: TENANT_ID,
      category: "marketing",
    });

    const responses = await Promise.all([
      GET(request(mutatePayload(token, { tenant_id: "22222222-2222-4222-8222-222222222222" }))),
      GET(request(mutatePayload(token, { category: "all" }))),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
