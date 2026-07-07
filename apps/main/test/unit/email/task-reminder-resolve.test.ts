// #970 — sendTaskReminderEmail routes through resolveEmailContent.
//
// Intent under test:
//   1. resolveEmailContent is called with email_type:"task_reminder" and the
//      correct variable set — validates that the wiring was done, not just that
//      sendEmail runs.
//   2. Override path (overrideBodyText != null) renders via renderOverrideBodyInLayout,
//      not the TaskReminder JSX component.
//   3. Default path (overrideBodyText null) renders via TaskReminder JSX.
//   4. A resolveEmailContent throw returns { status: "failed", reason: "template_resolution_failed" }.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({
  resolveEmailContent: vi.fn(),
  renderOverrideBodyInLayout: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: mocks.resolveEmailContent,
  renderOverrideBodyInLayout: mocks.renderOverrideBodyInLayout,
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: mocks.sendEmail,
}));

// TaskReminder is imported dynamically inside the function but we mock the
// module so renderToStaticMarkup returns a stable string.
vi.mock("react-dom/server", () => ({
  renderToStaticMarkup: () => "<p>task reminder html</p>",
}));

vi.mock("@/emails/TaskReminder", () => ({
  TaskReminder: () => null,
}));

function tableResult(table: string) {
  if (table === "tasks") {
    return {
      data: {
        id: "task-1",
        tenant_id: "t-1",
        title: "Follow up",
        description: "Some desc",
        due_at: "2026-07-01T00:00:00Z",
        priority: "high",
        assigned_to_user_id: "u-1",
        created_by_user_id: null,
      },
      error: null,
    };
  }
  if (table === "users") {
    return { data: { id: "u-1", email: "user@example.com", first_name: "Alex", last_name: "Chen" }, error: null };
  }
  if (table === "tenants") {
    return {
      data: {
        id: "t-1",
        legal_name: "Acme Travel",
        mailing_address: "1 Main St",
        email_send_pattern: "platform_resend",
        tenant_resend_api_key_encrypted: null,
        email_from_address: null,
        email_from_name: null,
      },
      error: null,
    };
  }
  if (table === "tenant_branding") {
    return { data: { logo_url: null, primary_color: null, secondary_color: null, accent_color: null, slogan: null }, error: null };
  }
  return { data: null, error: null };
}

function makeDb(): SupabaseClient {
  // Chainable builder: eq() returns itself so any number of .eq() calls work,
  // and maybeSingle() resolves with fixture data keyed by table name.
  const makeBuilder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => tableResult(table),
    };
    return b;
  };
  return { from: (table: string) => makeBuilder(table) } as unknown as SupabaseClient;
}

import { sendTaskReminderEmail } from "@/lib/tasks/send-reminder-email";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
  mocks.renderOverrideBodyInLayout.mockResolvedValue("<p>override html</p>");
});

describe("sendTaskReminderEmail — resolveEmailContent wiring (#970)", () => {
  it("calls resolveEmailContent with email_type:'task_reminder' and the correct variables", async () => {
    mocks.resolveEmailContent.mockResolvedValue({ subject: "Task reminder: Follow up", overrideBodyText: null });

    await sendTaskReminderEmail({ svc: makeDb(), task_id: "task-1", tenant_id: "t-1", reminder_id: "r-1" });

    expect(mocks.resolveEmailContent).toHaveBeenCalledOnce();
    const call = mocks.resolveEmailContent.mock.calls[0]![0];
    expect(call.email_type).toBe("task_reminder");
    expect(call.variables.task_title).toBe("Follow up");
    expect(call.variables.recipient_name).toBe("Alex Chen");
    expect(call.variables.priority).toBe("high");
    expect(call.tenant_id).toBe("t-1");
  });

  it("default path (no override): renders TaskReminder JSX, does NOT call renderOverrideBodyInLayout", async () => {
    mocks.resolveEmailContent.mockResolvedValue({ subject: "Task reminder: Follow up", overrideBodyText: null });

    const result = await sendTaskReminderEmail({ svc: makeDb(), task_id: "task-1", tenant_id: "t-1", reminder_id: "r-1" });

    expect(result.status).toBe("sent");
    expect(mocks.renderOverrideBodyInLayout).not.toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>task reminder html</p>",
      subject: "Task reminder: Follow up",
    }));
  });

  it("override path (overrideBodyText set): calls renderOverrideBodyInLayout, does NOT render TaskReminder JSX", async () => {
    mocks.resolveEmailContent.mockResolvedValue({ subject: "Custom subject", overrideBodyText: "Custom body text." });

    const result = await sendTaskReminderEmail({ svc: makeDb(), task_id: "task-1", tenant_id: "t-1", reminder_id: "r-1" });

    expect(result.status).toBe("sent");
    expect(mocks.renderOverrideBodyInLayout).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      html: "<p>override html</p>",
      subject: "Custom subject",
    }));
  });

  it("resolveEmailContent throw → { status: 'failed', reason: 'template_resolution_failed' }", async () => {
    mocks.resolveEmailContent.mockRejectedValue(new Error("tenant_email_templates read failed (task_reminder): connection refused"));

    const result = await sendTaskReminderEmail({ svc: makeDb(), task_id: "task-1", tenant_id: "t-1", reminder_id: "r-1" });

    expect(result).toEqual({ status: "failed", reason: "template_resolution_failed" });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
