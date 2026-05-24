/**
 * BP32 §32.13.2 — Screenshot vision-PII detector (STUB).
 *
 * Per the BP32 cost-deferral decision (MEMORY D-068), the Haiku vision
 * call is deferred. This stub returns `{detected: false}` regardless of
 * input. The HelpAIPanel UI uses the `detected` flag to decide whether
 * to show the warning banner before upload; with the stub there's no
 * banner — same as the spec's "warn-only" Phase 2 behavior in the
 * absence of any signal.
 *
 * The CONTRACT is stable: callers consume `{detected, categories}`.
 * Wiring the real Haiku vision call later only changes detection
 * accuracy, not the surface shape.
 *
 * Phase 3 behavior (operator flips `platform_settings.screenshot_pii_block_mode`
 * to TRUE after 90 days of data review): refuse upload + ask the user
 * to redact and re-upload. The block-mode logic lives in the UI; this
 * function returns the same shape regardless.
 */

export interface ScreenshotPiiResult {
  detected: boolean;
  categories: string[];
  stubbed: true;
  rationale: string;
}

const STUB_RESULT: ScreenshotPiiResult = {
  detected: false,
  categories: [],
  stubbed: true,
  rationale: "stub: Haiku vision-PII call deferred per BP32 cost decision (D-068)",
};

/**
 * Inspect a screenshot for PII (faces, license plates, ID documents,
 * financial data, screen content with PII). STUB returns false.
 *
 * `_image` is accepted as a `Buffer | Uint8Array | ArrayBuffer` so the
 * caller can pass whichever shape the upload pipeline produces; the
 * stub ignores it.
 *
 * TODO(help-screenshot-pii-haiku): wire the Haiku vision call via
 * instrumentedClaudeCall with the image attached. Operator opts in
 * when willing to pay per upload for the vision-PII signal.
 */
export async function detectScreenshotPii(
  _image: Buffer | Uint8Array | ArrayBuffer,
  _opts: { tenant_id: string },
): Promise<ScreenshotPiiResult> {
  void _image;
  void _opts;
  return STUB_RESULT;
}
