// BP24 §10 — Sentence-boundary buffering for streaming supervisor handoffs.
//
// Wraps a token-level text stream (typically from instrumentedClaudeStream)
// and yields complete sentences. The supervisor can then run cheap per-
// sentence checks (deny-list lookups, length caps, asset-id validation)
// against finished sentences instead of mid-token fragments.
//
// Boundary rules (in priority order):
//   1. A sentence terminator (. ? !) followed by whitespace or end-of-stream
//      flushes everything up to and including the terminator.
//   2. Common abbreviations (Mr., Mrs., Dr., e.g., i.e., U.S., etc.) do NOT
//      flush — they're held until a real boundary.
//   3. Decimal numbers ("$3.50", "2.5") do NOT flush — digit-on-both-sides
//      of the period suppresses.
//   4. Hard cap: 800 chars without a boundary still flushes to bound memory.
//      Configurable via opts.maxBufferChars.
//
// The buffer always flushes its trailing tail on stream end, even if it
// doesn't terminate with punctuation — the model's final partial sentence
// is still a complete unit of output and needs to reach the user.
//
// Per-sentence supervisor wiring is the *caller's* responsibility — this
// module only does the buffering. The supervisor is expected to be a quick
// synchronous-style predicate; awaiting heavy work between sentences would
// defeat the latency benefit of streaming.

export interface BufferOptions {
  maxBufferChars?: number;
}

const DEFAULT_MAX_BUFFER_CHARS = 800;

// Lowercased. The match is case-insensitive at the abbreviation lookup site.
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "mr", "mrs", "ms", "dr", "st", "sr", "jr",
  "e.g", "i.e", "etc", "vs", "u.s", "u.k", "u.s.a",
  "no", "fig", "p", "pp", "ch", "sec", "vol", "approx",
  // Cruise-specific
  "cstm", "embark", "disembark",
]);

// Internal: does ending `s` (with the terminator already chopped) end in an
// abbreviation? Walks back the last token (alpha chars + optional internal dots).
function endsInAbbreviation(s: string): boolean {
  // Grab the trailing token: letters and dots, no whitespace.
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(s);
  if (!m || !m[1]) return false;
  // Strip any trailing dot so "Mr." matches "mr" in the set.
  const tok = m[1].replace(/\.$/, "").toLowerCase();
  return ABBREVIATIONS.has(tok);
}

// Internal: is the period in `s[idx]` between two digits (decimal number)?
function isDecimalPoint(s: string, idx: number): boolean {
  if (s[idx] !== ".") return false;
  const prev = s[idx - 1];
  const next = s[idx + 1];
  return prev !== undefined && next !== undefined && /\d/.test(prev) && /\d/.test(next);
}

// Returns the index AFTER the next sentence terminator that should flush,
// or -1 if no flushable boundary is present.
//
// `boundaryProbeStart` lets callers skip re-scanning chunks they've already
// inspected (the buffer keeps growing; we only need to look at the new tail).
export function findNextBoundary(buf: string, boundaryProbeStart = 0): number {
  for (let i = boundaryProbeStart; i < buf.length; i++) {
    const c = buf[i];
    if (c !== "." && c !== "?" && c !== "!") continue;
    if (isDecimalPoint(buf, i)) continue;

    // Need a whitespace (or end of buffer) AFTER the terminator to be safe;
    // mid-token punctuation like URLs ("example.com") would otherwise flush.
    // The "end of buffer" case is deferred to the stream-end flush path —
    // mid-stream we wait for a whitespace boundary to disambiguate.
    const next = buf[i + 1];
    if (next === undefined) return -1;
    if (!/\s/.test(next)) continue;

    if (endsInAbbreviation(buf.slice(0, i))) continue;
    return i + 1; // index AFTER the terminator
  }
  return -1;
}

export async function* bufferToSentences(
  source: AsyncIterable<string>,
  opts: BufferOptions = {},
): AsyncIterable<string> {
  const maxBuffer = opts.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  let buf = "";

  for await (const chunk of source) {
    if (!chunk) continue;
    const scanFrom = Math.max(0, buf.length - 1); // include the last char in case the terminator just arrived
    buf += chunk;

    while (true) {
      const cut = findNextBoundary(buf, scanFrom);
      if (cut === -1) break;
      const sentence = buf.slice(0, cut).trim();
      buf = buf.slice(cut).replace(/^\s+/, "");
      if (sentence.length > 0) yield sentence;
    }

    if (buf.length >= maxBuffer) {
      // Hard cap reached — emit the buffered content as a "sentence" so we
      // don't grow unbounded on a runaway response (model hung in one long
      // un-terminated clause).
      yield buf.trim();
      buf = "";
    }
  }

  // Flush any trailing partial sentence.
  const tail = buf.trim();
  if (tail.length > 0) yield tail;
}
