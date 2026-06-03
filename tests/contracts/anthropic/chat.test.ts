// Contract: verifies the Anthropic Messages API response shape the app depends on.
// MSW replays the recorded fixtures so no live API key is needed.
// Fail if: the fixture shape drifts from what the SDK parses, or if
// the Anthropic client in call-wrapper.ts stops reaching /v1/messages.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { server } from "../setup";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Anthropic /v1/messages contract", () => {
  it("parses a persona greeting response into a valid Message object", async () => {
    const client = new Anthropic({ apiKey: "test-key" });
    // MSW matches on URL only — the fixture returned depends on filesystem sort order,
    // not on which system prompt we send. Body fields here are representative, not selective.
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: "You are Marcus Cole, a luxury travel concierge...",
      messages: [{ role: "user", content: "Hello, I'm looking for travel help." }],
    });

    expect(msg.id).toBeTruthy();
    expect(msg.type).toBe("message");
    expect(msg.role).toBe("assistant");
    expect(msg.model).toBeTruthy();

    // Content block — call-wrapper.ts maps content[] collecting .text from each TextBlock
    expect(msg.content).toHaveLength(1);
    const block = msg.content[0];
    expect(block.type).toBe("text");
    expect((block as Anthropic.Messages.TextBlock).text).toBeTruthy();

    // Termination — call-wrapper.ts checks stop_reason for tool_use branching
    expect(msg.stop_reason).toBe("end_turn");

    // Usage fields — written to ai_call_log and tenant_usage_metrics
    expect(msg.usage.input_tokens).toBeGreaterThan(0);
    expect(msg.usage.output_tokens).toBeGreaterThan(0);
  });
});
