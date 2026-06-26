// Regression for the TA/concierge chat "is the agent responding?" indicator.
//
// The animated thinking bubble must be visible for the WHOLE in-flight pause
// before the first token — including when the streaming buffer is the empty
// string "" that ChatExperience.send() seeds (and that delta_start/rewriting
// reset to), not just when it is null. Gating the bubble on `=== null` alone
// left the long pre-first-token wait blank, which is the user-reported bug.

import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StreamingArea } from "../../../src/components/chat/StreamingArea";

const INDICATOR = 'aria-label="Assistant is responding"';

function render(streamingDelta: string | null, thinking: boolean): string {
  return renderToStaticMarkup(
    <StreamingArea
      messages={[]}
      streamingDelta={streamingDelta}
      showMemoryIndicator={false}
      thinking={thinking}
    />,
  );
}

describe("StreamingArea thinking indicator", () => {
  it("shows while in flight before the first token (buffer null)", () => {
    expect(render(null, true)).toContain(INDICATOR);
  });

  it("shows while in flight when the buffer is empty-string (the send() seed)", () => {
    // This is the bug: send() sets streaming to "", so a `=== null` gate hid the
    // indicator during the entire wait.
    expect(render("", true)).toContain(INDICATOR);
  });

  it("hides once assistant text begins streaming", () => {
    expect(render("Hel", true)).not.toContain(INDICATOR);
  });

  it("hides when no turn is in flight", () => {
    expect(render(null, false)).not.toContain(INDICATOR);
  });
});
