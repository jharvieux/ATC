// Magic bytes validation for RAG file upload — #720
//
// Ensures attacker-controlled Content-Type cannot bypass MIME validation:
// the route rejects any file whose first bytes don't match the declared type.

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth/assert-permission", () => ({
  assertPermission: vi.fn(async () => ({
    ctx: { tenant_id: "t-1" },
    user: { id: "u-1" },
  })),
}));

vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
      }),
    },
    from: () => ({
      insert: async () => ({ error: null }),
    }),
  }),
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: async () => ({}) },
}));

const { POST } = await import("@/app/api/rag/submit/file/route");

function makeUploadReq(mimeType: string, bytes: Uint8Array, filename = "test"): Request {
  const form = new FormData();
  form.append("file", new File([bytes.buffer as ArrayBuffer], filename, { type: mimeType }));
  return new Request("http://localhost/api/rag/submit/file", {
    method: "POST",
    body: form,
  });
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x20, 0x20, 0x20]); // %PDF- ...
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x20, 0x20, 0x20, 0x20]); // PK\x03\x04 ...
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x20, 0x20, 0x20, 0x20]);
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RANDOM_BYTES = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);

describe("RAG file upload — magic bytes validation (#720)", () => {
  it("accepts a real PDF (magic bytes match)", async () => {
    const res = await POST(makeUploadReq("application/pdf", PDF_MAGIC, "test.pdf"));
    expect(res.status).not.toBe(415);
  });

  it("rejects non-PDF bytes declared as application/pdf → 415", async () => {
    const res = await POST(makeUploadReq("application/pdf", RANDOM_BYTES, "fake.pdf"));
    expect(res.status).toBe(415);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("magic_bytes_mismatch");
  });

  it("accepts real DOCX bytes (PK zip signature)", async () => {
    const res = await POST(
      makeUploadReq(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ZIP_MAGIC,
        "test.docx",
      ),
    );
    expect(res.status).not.toBe(415);
  });

  it("rejects non-DOCX bytes declared as docx → 415", async () => {
    const res = await POST(
      makeUploadReq(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        RANDOM_BYTES,
        "fake.docx",
      ),
    );
    expect(res.status).toBe(415);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("magic_bytes_mismatch");
  });

  it("accepts JPEG magic bytes declared as image/jpeg", async () => {
    const res = await POST(makeUploadReq("image/jpeg", JPEG_MAGIC, "photo.jpg"));
    expect(res.status).not.toBe(415);
  });

  it("rejects non-JPEG bytes declared as image/jpeg → 415", async () => {
    const res = await POST(makeUploadReq("image/jpeg", RANDOM_BYTES, "fake.jpg"));
    expect(res.status).toBe(415);
  });

  it("accepts PNG magic bytes declared as image/png", async () => {
    const res = await POST(makeUploadReq("image/png", PNG_MAGIC, "photo.png"));
    expect(res.status).not.toBe(415);
  });

  it("accepts text/plain with any bytes (no magic bytes for text)", async () => {
    const res = await POST(
      makeUploadReq("text/plain", RANDOM_BYTES, "notes.txt"),
    );
    expect(res.status).not.toBe(415);
  });
});
