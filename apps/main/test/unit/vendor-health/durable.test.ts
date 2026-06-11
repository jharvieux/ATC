// #786 — upsertVendorHealth: durable transition detection tests.
// Verifies: alert-once semantics (only one alert per transition), recovery
// alert on down→healthy, and fail-closed behavior when the DB write errors.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertVendorHealth, computeStatus, _resetVendorHealthForTests } from "@/lib/vendor-health/registry";

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

type Row = {
  status: string;
  consecutive_failures: number;
  status_changed_at: string | null;
} | null;

function makeDb(
  currentRow: Row,
  upsertError: { message: string } | null = null,
  selectError: { message: string } | null = null,
) {
  const upsertSpy = vi.fn().mockResolvedValue({ error: upsertError });
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                maybeSingle: () => Promise.resolve({ data: currentRow, error: selectError }),
              };
            },
          };
        },
        upsert: upsertSpy,
      };
    },
    _upsertSpy: upsertSpy,
  };
}

beforeEach(() => _resetVendorHealthForTests());

// ---------------------------------------------------------------------------
// computeStatus helper
// ---------------------------------------------------------------------------

describe("computeStatus", () => {
  it("healthy below 3 failures", () => {
    expect(computeStatus(0)).toBe("healthy");
    expect(computeStatus(2)).toBe("healthy");
  });

  it("degraded at 3-4 failures", () => {
    expect(computeStatus(3)).toBe("degraded");
    expect(computeStatus(4)).toBe("degraded");
  });

  it("down at 5+ failures", () => {
    expect(computeStatus(5)).toBe("down");
    expect(computeStatus(99)).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// upsertVendorHealth — transition detection
// ---------------------------------------------------------------------------

describe("upsertVendorHealth — transitions", () => {
  it("first run: healthy→healthy on success, transitioned=false", async () => {
    const db = makeDb(null);
    const result = await upsertVendorHealth({ vendor: "openai", success: true, db: db as never });
    expect(result).toEqual({ prior_status: "healthy", new_status: "healthy", transitioned: false });
  });

  it("first run: healthy→healthy on 1 failure (below threshold), transitioned=false", async () => {
    const db = makeDb(null);
    const result = await upsertVendorHealth({ vendor: "openai", success: false, error_message: "timeout", db: db as never });
    expect(result).toEqual({ prior_status: "healthy", new_status: "healthy", transitioned: false });
  });

  it("healthy→degraded at 3 consecutive failures, transitioned=true", async () => {
    const db = makeDb({ status: "healthy", consecutive_failures: 2, status_changed_at: null });
    const result = await upsertVendorHealth({ vendor: "stripe", success: false, error_message: "5xx", db: db as never });
    expect(result).toEqual({ prior_status: "healthy", new_status: "degraded", transitioned: true });
  });

  it("degraded→down at 5 consecutive failures, transitioned=true", async () => {
    const db = makeDb({ status: "degraded", consecutive_failures: 4, status_changed_at: null });
    const result = await upsertVendorHealth({ vendor: "stripe", success: false, error_message: "5xx", db: db as never });
    expect(result).toEqual({ prior_status: "degraded", new_status: "down", transitioned: true });
  });

  it("down→down on continued failure, transitioned=false (alert-once gate)", async () => {
    const db = makeDb({ status: "down", consecutive_failures: 7, status_changed_at: null });
    const result = await upsertVendorHealth({ vendor: "resend", success: false, error_message: "5xx", db: db as never });
    expect(result).toEqual({ prior_status: "down", new_status: "down", transitioned: false });
  });

  it("down→healthy on recovery, transitioned=true", async () => {
    const db = makeDb({ status: "down", consecutive_failures: 6, status_changed_at: null });
    const result = await upsertVendorHealth({ vendor: "resend", success: true, db: db as never });
    expect(result).toEqual({ prior_status: "down", new_status: "healthy", transitioned: true });
  });

  it("resets consecutive_failures to 0 on success", async () => {
    const db = makeDb({ status: "degraded", consecutive_failures: 3, status_changed_at: null });
    await upsertVendorHealth({ vendor: "inngest", success: true, db: db as never });
    const upsertCall = db._upsertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertCall.consecutive_failures).toBe(0);
    expect(upsertCall.last_error).toBeNull();
  });

  it("increments consecutive_failures on failure", async () => {
    const db = makeDb({ status: "healthy", consecutive_failures: 1, status_changed_at: null });
    await upsertVendorHealth({ vendor: "supabase", success: false, error_message: "conn reset", db: db as never });
    const upsertCall = db._upsertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertCall.consecutive_failures).toBe(2);
    expect(upsertCall.last_error).toBe("conn reset");
  });
});

// ---------------------------------------------------------------------------
// upsertVendorHealth — fail-closed on DB error
// ---------------------------------------------------------------------------

describe("upsertVendorHealth — DB write failure", () => {
  it("throws when upsert fails so probe Promise.allSettled catches it and no alert fires", async () => {
    const db = makeDb(null, { message: "connection refused" });
    await expect(
      upsertVendorHealth({ vendor: "openai", success: false, db: db as never }),
    ).rejects.toThrow("[vendor-health] upsert failed for openai: connection refused");
  });

  it("throws even when the computed transition would fire an alert", async () => {
    const db = makeDb({ status: "degraded", consecutive_failures: 4, status_changed_at: null }, { message: "timeout" });
    await expect(
      upsertVendorHealth({ vendor: "stripe", success: false, db: db as never }),
    ).rejects.toThrow("[vendor-health] upsert failed for stripe: timeout");
  });

  it("throws on SELECT error so a DB-read failure doesn't fire spurious alerts", async () => {
    // DB unavailable during read: prior_status would default to "healthy", causing
    // transitioned=true and a spurious alert. Instead we must throw immediately.
    const db = makeDb(null, null, { message: "connection timeout" });
    await expect(
      upsertVendorHealth({ vendor: "resend", success: false, db: db as never }),
    ).rejects.toThrow("[vendor-health] read failed for resend: connection timeout");
    expect(db._upsertSpy).not.toHaveBeenCalled();
  });
});
