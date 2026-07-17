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
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT" && url.startsWith("/api/tenant/email-templates/")) {
      return Promise.resolve(jsonRes({ ok: true }));
    }
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

// #1982 — the cascade reset runs as a PASSIVE effect after templates land. If
// a findBy* resolves on a poll tick outside an act() boundary, that queued
// effect doesn't flush until the NEXT act — which is the fireEvent below — so
// the reset's functional update lands AFTER the typed value in the same flush
// and wipes it. The window is sub-frame in a real browser (no user can type
// inside it); only test schedulers hit it, and only under full-suite load.
// Retrying until the value sticks is deterministic: the first attempt's act
// flushes the pending reset (which also sets resetForTypeRef, so it can never
// fire again for this type), and the retry always lands.
async function typeUntilItSticks(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await waitFor(() => {
    fireEvent.change(input, { target: { value } });
    expect(input.value).toBe(value);
  });
}

describe("EmailTemplatesSettingsPage — template-switch cascade reset (#1812)", () => {
  it("resets edit + preview state when switching template type, but leaves previewSource alone", async () => {
    installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });

    // Dirty the edit fields (retry-resilient: see typeUntilItSticks / #1982).
    const subjectInput = screen.getByPlaceholderText(
      "Your trip is confirmed, {{customer_name}}!",
    ) as HTMLInputElement;
    await typeUntilItSticks(subjectInput, "Edited subject");
    const bodyInput = screen.getByPlaceholderText(
      "Leave blank to use the platform default body.",
    ) as HTMLTextAreaElement;
    await typeUntilItSticks(bodyInput, "Edited body");

    // Switch the preview data source to "booking" and populate a selection —
    // this is the state the reset must clear on template-type switch.
    fireEvent.click(screen.getByLabelText(/Customer booking/));
    const bookingSearchInput = screen.getByPlaceholderText("Type a customer name…") as HTMLInputElement;
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
    // Wait for the new template's subject input value to be cleared by the reset cascade
    const newSubjectInput = screen.getByPlaceholderText("Welcome, {{customer_name}}!") as HTMLInputElement;
    await waitFor(() => {
      expect(newSubjectInput.value).toBe("");
    });
    // The body field is reset too — same cascade, same fields.
    const newBodyInput = screen.getByPlaceholderText(
      "Leave blank to use the platform default body.",
    ) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(newBodyInput.value).toBe("");
    });

    // The booking selection was cleared by the reset (back to the empty search box).
    expect(screen.queryByText("Clear selection")).toBeNull();
    // Wait for the booking search input value to be cleared
    await waitFor(() => {
      expect(bookingSearchInput.value).toBe("");
    });

    // previewSource itself is NOT in the reset list — "Customer booking" stays checked.
    const bookingRadio = screen.getByLabelText(/Customer booking/) as HTMLInputElement;
    expect(bookingRadio.checked).toBe(true);
  });

  it("clears the sailing selection chain and any loaded preview html on template-type switch", async () => {
    const fetchMock = installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => u === "/api/cruise-lines")).toBe(true);
    });

    // Resolve the full sailing cascade and load a preview from it — this is
    // the state the switch-reset must clear (line/ship/date selects back to
    // their disabled placeholder state, iframe gone) even though the radio
    // itself (previewSource) isn't reset.
    fireEvent.click(screen.getByLabelText(/Sailing from catalog/));
    const selects = () => Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
    const [lineSelect, shipSelect, dateSelect] = selects() as [
      HTMLSelectElement,
      HTMLSelectElement,
      HTMLSelectElement,
    ];
    fireEvent.change(lineSelect, { target: { value: "line-1" } });
    await waitFor(() => expect(shipSelect.disabled).toBe(false));
    fireEvent.change(shipSelect, { target: { value: "ship-1" } });
    await waitFor(() => expect(dateSelect.disabled).toBe(false));
    fireEvent.change(dateSelect, { target: { value: "sailing-1" } });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load preview" }) as HTMLButtonElement).toHaveProperty(
        "disabled",
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load preview" }));
    await waitFor(() => expect(document.querySelector("iframe")).toBeTruthy());

    // Switch template type.
    fireEvent.click(screen.getByText("Welcome"));
    await screen.findByPlaceholderText("Welcome, {{customer_name}}!");

    // The loaded preview html is cleared.
    await waitFor(() => expect(document.querySelector("iframe")).toBeNull());

    // previewSource stays on "sailing" (not reset), but the chain underneath
    // it is empty again — same disabled-cascade shape as first mount.
    const sailingRadio = screen.getByLabelText(/Sailing from catalog/) as HTMLInputElement;
    expect(sailingRadio.checked).toBe(true);
    const [lineAfter, shipAfter, dateAfter] = selects() as [
      HTMLSelectElement,
      HTMLSelectElement,
      HTMLSelectElement,
    ];
    expect(lineAfter.value).toBe("");
    expect(shipAfter.disabled).toBe(true);
    expect(dateAfter.disabled).toBe(true);
  });
});

describe("EmailTemplatesSettingsPage — template-switch clears banners (#1979)", () => {
  it("clears the saved-at success banner when switching to a new template type", async () => {
    installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved at/);

    fireEvent.click(screen.getByText("Welcome"));
    await waitFor(() => expect(screen.queryByText(/Saved at/)).toBeNull());
  });

  it("clears the error banner when switching to a new template type", async () => {
    const fetchMock = installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({}) } as Response),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Only the workspace owner can edit email templates.");

    fireEvent.click(screen.getByText("Welcome"));
    await waitFor(() =>
      expect(screen.queryByText("Only the workspace owner can edit email templates.")).toBeNull(),
    );
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

describe("EmailTemplatesSettingsPage — save-triggered reload (#1912)", () => {
  it("keeps sailing/booking selections and in-progress edits after a save reloads templates with an unchanged selectedType", async () => {
    const fetchMock = installFetchRouter();
    render(<EmailTemplatesSettingsPage />);
    await screen.findByRole("heading", { name: "Booking confirmation" });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u]) => u === "/api/cruise-lines")).toBe(true);
    });

    // Resolve the full sailing cascade.
    fireEvent.click(screen.getByLabelText(/Sailing from catalog/));
    const selects = () => Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
    const [lineSelect, shipSelect, dateSelect] = selects() as [
      HTMLSelectElement,
      HTMLSelectElement,
      HTMLSelectElement,
    ];
    fireEvent.change(lineSelect, { target: { value: "line-1" } });
    await waitFor(() => expect(shipSelect.disabled).toBe(false));
    fireEvent.change(shipSelect, { target: { value: "ship-1" } });
    await waitFor(() => expect(dateSelect.disabled).toBe(false));
    fireEvent.change(dateSelect, { target: { value: "sailing-1" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Load preview" }) as HTMLButtonElement).toHaveProperty(
        "disabled",
        false,
      );
    });

    // Also resolve a booking selection — previewSource is a single radio, but
    // the underlying sailing and booking selection state are independent, so
    // both stay populated at once.
    fireEvent.click(screen.getByLabelText(/Customer booking/));
    const bookingSearchInput = screen.getByPlaceholderText("Type a customer name…") as HTMLInputElement;
    fireEvent.change(bookingSearchInput, { target: { value: "Jamie" } });
    const result = await screen.findByText("Jamie Rivera");
    fireEvent.click(result);
    await screen.findByText("Clear selection");

    // Dirty the subject too, then save it (retry-resilient: #1982).
    const subjectInput = screen.getByPlaceholderText(
      "Your trip is confirmed, {{customer_name}}!",
    ) as HTMLInputElement;
    await typeUntilItSticks(subjectInput, "Edited subject");

    // save() PUTs, then calls load() again on success. load() replaces
    // `templates` with a brand-new array reference, but selectedType never
    // changed — this is the exact shape that used to re-fire the
    // template-switch reset cascade and wipe the sailing/booking selections
    // above even though the user never touched the template-type nav (#1912).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved at/);

    // The just-typed subject survives the reload (it isn't reset back to the
    // mocked override's "Custom subject").
    expect((screen.getByDisplayValue("Edited subject") as HTMLInputElement).value).toBe("Edited subject");

    // The booking selection survives — the input still shows the picked
    // contact, not the blank/query state the reset cascade would produce.
    expect(screen.getByText("Clear selection")).toBeTruthy();
    expect(bookingSearchInput.value).toBe("Jamie Rivera — Wanderer");

    // The sailing selection survives too: switching the data-source radio
    // back to "sailing" shows the same line/ship/date still selected.
    fireEvent.click(screen.getByLabelText(/Sailing from catalog/));
    const [lineAfter, shipAfter, dateAfter] = selects() as [HTMLSelectElement, HTMLSelectElement, HTMLSelectElement];
    expect(lineAfter.value).toBe("line-1");
    expect(shipAfter.value).toBe("ship-1");
    expect(dateAfter.value).toBe("sailing-1");
  });
});
