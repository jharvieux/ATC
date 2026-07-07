# Help docs — authoring & screenshot pipeline

How to add or update customer-facing help docs (`apps/main/content/help/*.md`)
and their screenshots. Screenshots are **generated from a manifest, never
hand-taken** — when the UI changes you re-run one command instead of
re-cropping images by hand.

## Moving parts

| Piece | Where | Role |
|---|---|---|
| Docs | `apps/main/content/help/*.md` | Source of truth; front-matter (`slug`, `title`, `order`, `category`, `tiers`) drives the viewer |
| Viewer | `/admin/help/[slug]`, `/admin/help/print` | remark/rehype render of the markdown |
| RAG sync | `apps/main/scripts/sync-help-docs-to-rag.ts` | Chunks doc **text** for the Help AI — images are invisible to it except their alt text |
| Export | `POST /api/help/docs/export` → Inngest worker | PDF/Word of all docs |
| Screenshot manifest | `scripts/help-screenshots/manifest.ts` | One `Shot` entry per image: page, state-prep, annotations |
| Capture | `pnpm help:screenshots` | Regenerates `apps/main/public/help/<doc>/<id>.png` from the manifest |
| Drift gate | `pnpm check:help-screenshots` (in `verify` + CI Guards) | Fails if manifest ↔ PNGs ↔ doc references disagree |

## Capture environment — beta demo tenant

Screenshots are captured against the **beta deployment logged into the
dedicated demo tenant** (decision 2026-07-08): real product rendering, zero
customer PII possible because the tenant contains only fabricated data.

Required env (put in your shell, never commit; values live with the operator):

```bash
HELP_SHOTS_BASE_URL=https://<demo-slug>.ai-travelconcierge.com
HELP_SHOTS_EMAIL=<demo tenant owner email>
HELP_SHOTS_PASSWORD=<demo tenant owner password>
NEXT_PUBLIC_SUPABASE_URL=<beta Supabase URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<beta anon key>
```

Auth is GoTrue password-grant + cookie injection (same pattern as
`tests/e2e/global-setup.ts`) because the UI is OAuth-only.

## Adding a screenshot to a doc

1. **Manifest entry** in `scripts/help-screenshots/manifest.ts`:

   ```ts
   {
     doc: "branding",            // front-matter slug of the doc
     id: "logo-fields",          // → public/help/branding/logo-fields.png
     path: "/settings/branding",
     annotations: [
       { type: "box", selector: "#logo-light-url", label: "Light-mode logo" },
       { type: "callout", selector: "button[type=submit]", n: 1 },
     ],
   }
   ```

   Use `prepare` to click a page into the state you need, `clip` to crop to
   one panel, `fullPage` for long pages. Annotations render as indigo boxes /
   numbered badges injected into the live DOM — pixel-identical every run.

2. **Capture**: `pnpm help:screenshots -- --doc branding`

3. **Reference it** from the doc with a real markdown image and a
   *descriptive* alt text (the drift gate rejects empty alt — alt text is
   what the Help AI and screen readers see):

   ```markdown
   ![Branding page with the three logo URL fields highlighted](/help/branding/logo-fields.png)
   ```

4. `pnpm check:help-screenshots` — must pass before the PR.

All three pieces (manifest entry, PNG, doc reference) land in the same PR;
the drift gate enforces it.

## When the UI changes

Re-run capture for the affected docs and commit the new PNGs:

```bash
pnpm help:screenshots -- --doc branding
```

If a selector moved, the capture fails loudly naming the selector — fix the
manifest entry, don't screenshot around it. There is no automated staleness
detection for *visual* drift (the gate catches structural drift only); when
you ship a UI change to a screen that appears in help docs, re-capture it in
the same effort.

## Writing conventions (carried from the original docs)

- Front-matter: `title`, `slug`, `order`, `category`, `tiers` (empty = all).
- Second person, task-first ("Open **Settings → Branding**"), plain English —
  the audience is travel agents, not engineers.
- Tier-gated features get an "Available on:" callout at the top.
- New docs: pick the next free `order`, name the file `NN-topic.md`.
- Never leave a bare `[Screenshot: ...]` placeholder in a *new* doc — add the
  manifest entry and capture in the same PR. (Legacy placeholders are
  warn-only in the drift gate until they're all filled.)
