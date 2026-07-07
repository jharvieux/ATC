// Help-doc screenshot manifest — single source of truth for every image
// referenced by `apps/main/content/help/*.md`.
//
// Each entry describes one screenshot declaratively: which page, what state
// to put it in, and what to annotate. `pnpm help:screenshots` regenerates
// the PNGs from this manifest (docs/runbooks/help-docs.md has the full
// procedure, including the demo-tenant environment it runs against).
// `pnpm check:help-screenshots` enforces manifest ↔ files ↔ docs consistency.
//
// Screenshots are GENERATED, never hand-taken: when the UI changes, fix the
// entry here (if a selector moved) and re-run capture — every image comes
// back pixel-consistent (same viewport, same annotation style).

import type { Page } from "@playwright/test";

export interface ShotAnnotation {
  /** CSS selector of the element to mark. Must be visible at capture time. */
  selector: string;
  /**
   * box     — rounded outline around the element
   * callout — numbered badge at the element's top-left corner (set `n`);
   *           reference the number from the doc text ("callout 2")
   */
  type: "box" | "callout";
  /** Callout number (required when type === 'callout'). */
  n?: number;
  /** Short label rendered next to the box/badge. Keep under ~30 chars. */
  label?: string;
}

export interface Shot {
  /** Help-doc slug this image belongs to (front-matter `slug`). */
  doc: string;
  /** File name without extension; output is public/help/<doc>/<id>.png */
  id: string;
  /** App path to navigate to, e.g. "/settings/branding". */
  path: string;
  /**
   * Put the page into the state the screenshot needs (open a tab, fill a
   * field, hover a row). Runs after navigation, before annotation.
   */
  prepare?: (page: Page) => Promise<void>;
  /** Clip the shot to this selector's bounding box (plus padding) instead
   *  of the whole viewport. Use for a single panel or form section. */
  clip?: string;
  /** Capture the full scrollable page instead of the viewport. */
  fullPage?: boolean;
  annotations?: ShotAnnotation[];
}

/** Uniform capture geometry — every help image renders at the same scale. */
export const VIEWPORT = { width: 1280, height: 800 };
export const DEVICE_SCALE_FACTOR = 2;

// Entries land together with their captured PNG and the doc edit that
// references them (the drift check requires all three to move in lockstep).
export const SHOTS: Shot[] = [];
