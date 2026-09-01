// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchIndexingCard } from "@/app/(console)/settings/branding/page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchIndexingCard", () => {
  it("lets an Agency owner opt in after custom-domain verification", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          agency_eligible: true,
          custom_domain: "harborlighttravel.com",
          custom_domain_status: "verified",
          search_indexing_enabled: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ search_indexing_enabled: true }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchIndexingCard />);
    const toggle = await screen.findByRole("checkbox", {
      name: "Allow search engines to index this custom domain",
    });
    fireEvent.click(toggle);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ search_indexing_enabled: true }),
    });
  });

  it("does not render the toggle outside the Agency tier", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          agency_eligible: false,
          custom_domain: null,
          custom_domain_status: "none",
          search_indexing_enabled: false,
        }),
      ),
    );

    render(<SearchIndexingCard />);

    expect(
      await screen.findByText(/available on the Agency tier/),
    ).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the error state when the save request is rejected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          agency_eligible: true,
          custom_domain: "harborlighttravel.com",
          custom_domain_status: "verified",
          search_indexing_enabled: false,
        }),
      )
      .mockRejectedValueOnce(new Error("network_unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchIndexingCard />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Allow search engines to index this custom domain",
      }),
    );

    expect(await screen.findByText("network_unavailable")).toBeTruthy();
  });

  it("shows the error state when the save response is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          agency_eligible: true,
          custom_domain: "harborlighttravel.com",
          custom_domain_status: "verified",
          search_indexing_enabled: false,
        }),
      )
      .mockResolvedValueOnce(new Response("upstream unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    render(<SearchIndexingCard />);
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Allow search engines to index this custom domain",
      }),
    );

    expect(await screen.findByText("save_failed")).toBeTruthy();
  });
});
