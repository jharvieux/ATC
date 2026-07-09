// #1593 — shared SSE (text/event-stream) chunk-buffering.
//
// A network chunk boundary can land anywhere, including mid-line — a
// `data: ...\n\n` frame can be split so that neither half starts with
// `data: `. Parsing each chunk independently (as HelpAIPanel used to)
// silently drops or garbles the split line, and can miss a `[DONE]` or
// `[REWRITE]` sentinel that straddles the boundary. Carrying the trailing
// partial line into the next chunk (as ChatExperience already did) fixes
// this. Extracted here so both components share one implementation
// instead of a third divergent copy.
export function splitSseLines(buffer: string, chunk: string): { lines: string[]; remainder: string } {
  const combined = buffer + chunk;
  const lines = combined.split("\n");
  const remainder = lines.pop() ?? "";
  return { lines, remainder };
}
