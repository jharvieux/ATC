// @vitest-environment jsdom
//
// #1812 — characterization tests for the cascading-state behavior of the
// email-templates settings page (28 hooks, 954 lines, previously ZERO test
// coverage — flagged HIGH RISK by the god-component audit). These tests
// exist to be the safety net for a future reducer restructuring: they pin
// the CURRENT observable behavior of the two interdependent state cascades
// so a rewrite that silently changes behavior fails loudly here, before it
// reaches an operator's browser.
//
// Cascade 1 (template-type switch): switching the selected template type
// resets exactly the edit/preview state that belongs to the PREVIOUS
// template (subject, body, sailing/booking selections, preview html, error/
// saved banners) while explicitly leaving `previewSource` (the sample/
// sailing/booking radio choice) untouched — a plausible "reset everything"
// rewrite bug this pins against.
//
// Cascade 2 (sailing line → ship → sailing date): selecting a line clears
// the ship+date children and fetches that line's ships; selecting a ship
// clears the date child and fetches that ship's sailings; only a fully
// resolved date selection flips `canOpenPreview` on. This is the shape most
// at risk from a hooks→reducer rewrite that flattens the cascade and drops a
// reset step.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

vi.mock("@/lib/format-date", () => ({
  formatDate: (d: string) => d,
}));

const EmailTemplatesSettingsPage = (
  await import("@/app/(console)/settings/email-templates/page")
).default;

function templateEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "booking_confirmation",
    label: "Booking confirmation",
    description: "Sent when a booking is confirmed.",
    default_subject_template: "Your trip is confirmed, {{customer_name}}!",
    variables: [{ name: "customer_name", description: "Customer name", sample: "Alex" }],
    ai_content: null,
    override: { subject_template: "Custom subject", body_template: "Custom body", updated_at: "2026-01-01" },
    ...overrides,
  };
}

function welcomeEntry() {
  return {
    type: "welcome",
    label: "Welcome",
    description: "Sent on signup.",
    default_subject_template: "Welcome, {{customer_name}}!",
    variables: [{ name: "customer_name", description: "Customer name", sample: "Sam" }],
    ai_content: null,
    override: null,
  };
}

const LINES = [{ id: "line-1", display_name: "Royal Seas" }];
const SHIPS = [{ id: "ship-1", canonical_name: "Wanderer", ship_class: null }];
const SAILINGS = [{ id: "sailing-1", departure_date: "2027-03-01", departure_port: "Miami", duration_nights: 7 }];

function jsonRes(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function installFetchRouter() {
  const bookingResults = [
    {
      id: "booking-1",
      ship_name: "Wanderer",
      cruise_line: "Royal Seas",
      sailing_date: "2027-03-01",
      primary_contact: { first_name: "Jamie", last_name: "Rivera" },
    },
  ];
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/tenant/email-templates") {
      return Promise.resolve(jsonRes({ templates: [templateEntry(), welcomeEntry()] }));
    }
    if (url === "/api/cruise-lines") {
      return Promise.resolve(jsonRes({ lines: LINES }));
    }
    if (url.startsWith("/api/cruise-ships")) {
      return Promise.resolve(jsonRes({ ships: SHIPS }));
    }
    if (url.startsWith("/api/cruise-sailings")) {
      return Promise.resolve(jsonRes({ sailings: SAILINGS }));
    }
    if (url.startsWith("/api/bookings?contact_query=")) {
      return Promise.resolve(jsonRes({ bookings: bookingResults }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("EmailTemplatesSettingsPage — template-switch cascade reset (#1812)", () => {
  it("resets edit + preview state when switching template type, but leaves previewSource alone", async () => {
    installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });

    // Dirty the edit fields.
    const subjectInput = screen.getByPlaceholderText(
      "Your trip is confirmed, {{customer_name}}!",
    ) as HTMLInputElement;
    fireEvent.change(subjectInput, { target: { value: "Edited subject" } });
    expect(subjectInput.value).toBe("Edited subject");

    // Switch the preview data source to "booking" and populate a selection —
    // this is the state the reset must clear on template-type switch.
    fireEvent.click(screen.getByLabelText(/Customer booking/));
    const bookingSearchInput = screen.getByPlaceholderText("Type a customer name…");
    fireEvent.change(bookingSearchInput, { target: { value: "Jamie" } });
    const result = await screen.findByText("Jamie Rivera");
    fireEvent.click(result);
    await screen.findByText("Clear selection");

    // Switch template type in the left nav.
    fireEvent.click(screen.getByText("Welcome"));

    // Subject/body reset to the newly-selected template's own state (no override → blank).
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Welcome, {{customer_name}}!")).toBeTruthy();
    });
    const newSubjectInput = screen.getByPlaceholderText("Welcome, {{customer_name}}!") as HTMLInputElement;
    expect(newSubjectInput.value).toBe("");

    // The booking selection was cleared by the reset (back to the empty search box).
    expect(screen.queryByText("Clear selection")).toBeNull();
    expect((screen.getByPlaceholderText("Type a customer name…") as HTMLInputElement).value).toBe("");

    // previewSource itself is NOT in the reset list — "Customer booking" stays checked.
    const bookingRadio = screen.getByLabelText(/Customer booking/) as HTMLInputElement;
    expect(bookingRadio.checked).toBe(true);
  });
});

describe("EmailTemplatesSettingsPage — sailing cascade (#1812)", () => {
  it("clears ship+date children on line change and enables preview only once a date is chosen", async () => {
    const fetchMock = installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => u === "/api/cruise-lines")).toBe(true);
    });

    fireEvent.click(screen.getByLabelText(/Sailing from catalog/));

    const loadPreviewButton = () => screen.getByRole("button", { name: "Load preview" }) as HTMLButtonElement;
    // Sample source starts enabled by default; switching to "sailing" with
    // nothing selected must disable it until a full line→ship→date chain resolves.
    expect(loadPreviewButton().disabled).toBe(true);

    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
    expect(selects).toHaveLength(3);
    const [lineSelect, shipSelect, dateSelect] = selects as [HTMLSelectElement, HTMLSelectElement, HTMLSelectElement];

    fireEvent.change(lineSelect, { target: { value: "line-1" } });
    await waitFor(() => expect(shipSelect.disabled).toBe(false));
    expect(loadPreviewButton().disabled).toBe(true);

    fireEvent.change(shipSelect, { target: { value: "ship-1" } });
    await waitFor(() => expect(dateSelect.disabled).toBe(false));
    expect(loadPreviewButton().disabled).toBe(true);

    fireEvent.change(dateSelect, { target: { value: "sailing-1" } });
    await waitFor(() => expect(loadPreviewButton().disabled).toBe(false));

    // Changing the line again resets the ship/date selects back to their
    // disabled placeholder state — the cascade's reset-on-ancestor-change rule.
    fireEvent.change(lineSelect, { target: { value: "" } });
    await waitFor(() => expect(loadPreviewButton().disabled).toBe(true));
    expect(shipSelect.disabled).toBe(true);
    expect(dateSelect.disabled).toBe(true);
  });
});

describe("EmailTemplatesSettingsPage — booking search debounce (#1812)", () => {
  it("does not fetch below the 2-char threshold and debounces a single fetch for rapid keystrokes", async () => {
    vi.useFakeTimers();
    const fetchMock = installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Booking confirmation" })).toBeTruthy());

    fireEvent.click(screen.getByLabelText(/Customer booking/));
    const input = screen.getByPlaceholderText("Type a customer name…");

    fireEvent.change(input, { target: { value: "J" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/bookings"))).toBe(false);

    fireEvent.change(input, { target: { value: "Ja" } });
    fireEvent.change(input, { target: { value: "Jam" } });
    fireEvent.change(input, { target: { value: "Jami" } });
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/bookings"))).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    const bookingCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/bookings"));
    expect(bookingCalls).toHaveLength(1);
    expect(String(bookingCalls[0]?.[0])).toContain(encodeURIComponent("Jami"));
  });
});
