// @vitest-environment jsdom
//
// #1813 audit follow-up — pre-pr-reviewer flagged that the resource-link-rows
// stable-key fix (ResourcesEditor.tsx, key={link._key} at ~line 167) shipped
// with zero test coverage: a regression back to key={lIdx} would pass CI
// silently. Two behaviors pinned here, mirroring the passenger-rows coverage
// added for the same #1813 fix:
//
// 1. Mid-list-removal DOM identity — removeLink filters a section's links by
//    index, so every row after the removed one shifts down a position. The
//    rendered *value* of a controlled input is correct either way (it's
//    always driven by current state), so the regression this test targets is
//    DOM node survival, not value drift: capture the actual node reference
//    for row 2 before removing row 1, then assert that same node is still
//    attached to the document afterward. With index keys, React would tear
//    down and rebuild rows on removal instead of re-indexing the surviving
//    node in place.
// 2. Client-only key never reaches the server — `_key` is stripped from the
//    PATCH body (ResourcesEditor.tsx ~line 85) before it's sent to
//    /api/resources/[id].

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

import { ResourcesEditor } from "@/components/deliverables/ResourcesEditor";

const BOOKING_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const RESOURCES_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function jsonResponse(status: number, data: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function mockFetchSequence(...handlers: Array<(url: string, init?: RequestInit) => unknown>) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function baseResources() {
  return {
    id: RESOURCES_ID,
    access_token: "tok-123",
    status: "draft" as const,
    sections: [
      {
        section_label: "Travel documents",
        links: [
          { label: "Passport form", url: "https://example.com/1" },
          { label: "Visa info", url: "https://example.com/2" },
          { label: "Insurance", url: "https://example.com/3" },
        ],
      },
    ],
    packing_checklist: null,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ResourcesEditor — stable link-row keys (#1813)", () => {
  it("keeps the same DOM node (and its edited value) attached after removing an earlier row", async () => {
    mockFetchSequence(() => jsonResponse(200, { resources: baseResources() }));

    render(<ResourcesEditor booking_id={BOOKING_ID} />);
    await screen.findByText("Trip resources");

    const labelInputsBefore = screen.getAllByPlaceholderText("Label");
    expect(labelInputsBefore).toHaveLength(3);

    // Row 2 (lIdx 1) is the one we track through the removal.
    const trackedInput = labelInputsBefore[1] as HTMLInputElement;
    fireEvent.change(trackedInput, { target: { value: "ZKQ-LINK-2" } });

    // Remove row 1 (lIdx 0) — a mid-list removal that shifts row 2 down to
    // index 0.
    const removeButtons = screen.getAllByText("×");
    fireEvent.click(removeButtons[0]!);

    await waitFor(() => {
      expect(screen.getAllByPlaceholderText("Label")).toHaveLength(2);
    });

    expect(document.body.contains(trackedInput)).toBe(true);
    expect(trackedInput.value).toBe("ZKQ-LINK-2");
  });

  it("strips the client-only _key from the resources PATCH payload", async () => {
    let capturedBody: string | undefined;
    mockFetchSequence(
      () => jsonResponse(200, { resources: baseResources() }),
      (_url, init) => {
        capturedBody = init?.body as string;
        return jsonResponse(200, baseResources());
      },
    );

    render(<ResourcesEditor booking_id={BOOKING_ID} />);
    await screen.findByText("Trip resources");

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    const body = JSON.parse(capturedBody!) as {
      sections: Array<{ links: Array<Record<string, unknown>> }>;
    };
    expect(body.sections[0]!.links).toHaveLength(3);
    for (const link of body.sections[0]!.links) {
      expect(link).not.toHaveProperty("_key");
    }
  });
});
