// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/crm/contacts" }));

import { WorkspaceSidebar } from "@/components/tenant-shell/WorkspaceSidebar";

afterEach(cleanup);

describe("WorkspaceSidebar", () => {
  it("keeps the pre-cruise menu item visible as an icon when collapsed", () => {
    render(<WorkspaceSidebar role="agent" />);

    const link = screen.getByTitle("Pre-cruise emails");
    expect(link.getAttribute("href")).toBe("/crm/pre-cruise-emails");
    expect(link.querySelector("svg")).not.toBeNull();
  });
});
