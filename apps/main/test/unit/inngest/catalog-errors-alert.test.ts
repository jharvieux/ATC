// #1094 — alertCatalogErrors sends a "low" severity operator alert when
// catalog write failures accumulate during the sailing ingest run.

import { describe, it, expect, vi } from "vitest";

const sendAlert = vi.fn();

vi.mock("@/lib/monitoring/send-operator-alert", () => ({
  sendOperatorAlert: sendAlert,
}));

describe("alertCatalogErrors (#1094)", () => {
  it("calls sendOperatorAlert with signal=cruisemapper_catalog_write_errors and severity=low", async () => {
    const { alertCatalogErrors } = await import(
      "@/inngest/refresh-cruisemapper-sailings"
    );

    sendAlert.mockResolvedValue(undefined);
    const result = await alertCatalogErrors(3, 47);

    expect(sendAlert).toHaveBeenCalledOnce();
    const call = sendAlert.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.severity).toBe("low");
    expect(call.signal).toBe("cruisemapper_catalog_write_errors");
    expect(call.payload).toMatchObject({ catalog_errors: 3, catalog_upserted: 47 });
    expect(result).toEqual({ alerted: true });
  });
});
