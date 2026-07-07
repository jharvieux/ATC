// @vitest-environment jsdom
//
// §17.3 / §28.9 / §28.15 — issue #1668 gates on the signup landing page:
//   1. SIGNUP_ENABLED=false shows the "closed" state instead of the form.
//   2. Each OAuth button only renders when its OAUTH_*_ENABLED flag is true.

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const envFlags = vi.hoisted(() => ({
  SIGNUP_ENABLED: true,
  OAUTH_GOOGLE_ENABLED: true,
  OAUTH_MICROSOFT_ENABLED: true,
  OAUTH_FACEBOOK_ENABLED: true,
}));
vi.mock("@/lib/env", () => ({ env: () => envFlags }));

import SignupPage from "@/app/signup/page";

afterEach(() => {
  cleanup();
  envFlags.SIGNUP_ENABLED = true;
  envFlags.OAUTH_GOOGLE_ENABLED = true;
  envFlags.OAUTH_MICROSOFT_ENABLED = true;
  envFlags.OAUTH_FACEBOOK_ENABLED = true;
});

describe("/signup — SIGNUP_ENABLED gate (#1668)", () => {
  it("renders the signup form when SIGNUP_ENABLED=true (default)", () => {
    render(<SignupPage />);
    expect(screen.getAllByText(/Continue with Google/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/currently closed/i)).toBeNull();
  });

  it("renders a closed-state message instead of the form when SIGNUP_ENABLED=false", () => {
    envFlags.SIGNUP_ENABLED = false;
    render(<SignupPage />);
    expect(screen.getByText(/currently closed/i)).toBeTruthy();
    expect(screen.queryByText(/Continue with Google/i)).toBeNull();
  });
});

describe("/signup — OAuth buttons gated by OAUTH_*_ENABLED (#1668)", () => {
  it("hides the Google button when OAUTH_GOOGLE_ENABLED=false", () => {
    envFlags.OAUTH_GOOGLE_ENABLED = false;
    render(<SignupPage />);
    expect(screen.queryByText(/Continue with Google/i)).toBeNull();
    expect(screen.getAllByText(/Continue with Microsoft/i).length).toBeGreaterThan(0);
  });

  it("hides the Microsoft button when OAUTH_MICROSOFT_ENABLED=false", () => {
    envFlags.OAUTH_MICROSOFT_ENABLED = false;
    render(<SignupPage />);
    expect(screen.queryByText(/Continue with Microsoft/i)).toBeNull();
    expect(screen.getAllByText(/Continue with Google/i).length).toBeGreaterThan(0);
  });

  it("hides the Facebook button when OAUTH_FACEBOOK_ENABLED=false", () => {
    envFlags.OAUTH_FACEBOOK_ENABLED = false;
    render(<SignupPage />);
    expect(screen.queryByText(/Continue with Facebook/i)).toBeNull();
    expect(screen.getAllByText(/Continue with Google/i).length).toBeGreaterThan(0);
  });

  it("shows all three buttons when all flags are true (default)", () => {
    render(<SignupPage />);
    expect(screen.getAllByText(/Continue with Google/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Continue with Microsoft/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Continue with Facebook/i).length).toBeGreaterThan(0);
  });
});
