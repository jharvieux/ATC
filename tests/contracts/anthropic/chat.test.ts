/**
 * Contract tests — Anthropic chat completions
 *
 * One test per persona. MSW replays committed fixture responses — no real
 * Anthropic calls are made in PR-track mode.
 *
 * TODO: Replace skip blocks with real assertions once Anthropic wrapper
 * functions exist in src/lib/anthropic/.
 */

import { describe, it, beforeAll, afterAll, afterEach } from "vitest";
import { server } from "../setup";

const PERSONAS = [
  "marcus",
  "marco",
  "priya",
  "captain-dave",
  "maya",
  "jenny",
] as const;

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Anthropic / chat completions", () => {
  for (const persona of PERSONAS) {
    it.skip(`${persona} — returns message with text content`, async () => {
      // TODO: implement once src/lib/anthropic/chat.ts exists
      // const result = await sendChatMessage({ persona, message: "Hello, I'm looking for travel help." });
      // expect(result.content).toBeTruthy();
      // expect(result.role).toBe("assistant");
    });
  }

  it.skip("tool-call invocation — returns tool_use stop_reason", async () => {
    // TODO: implement once src/lib/anthropic/chat.ts supports tool calling
  });

  it.skip("streaming response — yields content chunks", async () => {
    // TODO: implement once src/lib/anthropic/chat.ts supports streaming
  });
});
