// @vitest-environment jsdom
//
// specs/design_handoff_group_landing/ theme toggle. Mirrors the (untested)
// lib/ta-theme/use-ta-theme.ts pattern this hook was modeled on.
//
// Covered:
//  - No stored preference falls back to prefers-color-scheme
//  - A stored preference wins over prefers-color-scheme
//  - Toggling persists to localStorage and updates document.documentElement
//  - Two independently-mounted consumers stay in sync via the custom event

import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useCruiseTheme } from "@/lib/group-invite/use-cruise-theme";

function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function ThemeConsumer({ label }: { label: string }) {
  const [theme, toggle] = useCruiseTheme();
  return (
    <button type="button" onClick={toggle} data-testid={label}>
      {theme}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-cruise-theme");
});

afterEach(() => {
  cleanup();
});

describe("useCruiseTheme", () => {
  it("falls back to prefers-color-scheme when nothing is stored", () => {
    mockMatchMedia(true);
    render(<ThemeConsumer label="a" />);
    expect(screen.getByTestId("a").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-cruise-theme")).toBe("dark");
  });

  it("a stored preference wins over prefers-color-scheme", () => {
    mockMatchMedia(true); // system prefers dark...
    window.localStorage.setItem("cruise-theme", "light"); // ...but user chose light
    render(<ThemeConsumer label="a" />);
    expect(screen.getByTestId("a").textContent).toBe("light");
  });

  it("toggling persists to localStorage and updates the documentElement attribute", () => {
    mockMatchMedia(false);
    render(<ThemeConsumer label="a" />);
    expect(screen.getByTestId("a").textContent).toBe("light");

    act(() => {
      fireEvent.click(screen.getByTestId("a"));
    });

    expect(screen.getByTestId("a").textContent).toBe("dark");
    expect(window.localStorage.getItem("cruise-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-cruise-theme")).toBe("dark");
  });

  it("keeps two independently-mounted consumers in sync", () => {
    mockMatchMedia(false);
    render(
      <>
        <ThemeConsumer label="a" />
        <ThemeConsumer label="b" />
      </>,
    );
    expect(screen.getByTestId("a").textContent).toBe("light");
    expect(screen.getByTestId("b").textContent).toBe("light");

    act(() => {
      fireEvent.click(screen.getByTestId("a"));
    });

    expect(screen.getByTestId("a").textContent).toBe("dark");
    expect(screen.getByTestId("b").textContent).toBe("dark");
  });
});
