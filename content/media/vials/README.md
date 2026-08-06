# Vial image library — the correct product image for every peptide

This folder is the **single source of truth for product (vial) images** used
in any marketing content: peptide posts, the creative compositor, ads, and
Metricool. Lookup is **by product name**, so the wrong-vial bug
(a SELANK vial on a CJC-1295 post) is structurally impossible — the image is
resolved from the post's own product, never chosen by hand.

## How to add a real vial

1. Photograph or export the product's vial. **A transparent-background PNG
   cutout is strongly preferred** so it composites cleanly onto any scene.
2. Save it as `content/media/vials/<slug>.png`. The `<slug>` must match the
   product slug in `lib/social/peptide-catalog.js` (e.g. `retatrutide.png`,
   `cjc-1295-ipamorelin.png`, `bpc-157.png`).
3. For a product not in the approved catalog, add it to `manifest.json`
   first (`slug`, `name`, optional `aliases`), then drop `<slug>.png`.
4. Check coverage:

   ```bash
   npm run social:vials
   ```

   It lists every product and whether its real vial is present or missing.

## How it's used

- `lib/social/vial-registry.js` — `resolveVial(name)` returns the entry and
  whether the real asset is `provided`; `coverage()` reports the whole set.
- `scripts/generate-peptide-images.js` — when a product's real vial exists,
  the AI renders a **vial-free** cinematic background (an empty rock pedestal)
  and the compositor drops the **real** vial onto it, then overlays crisp
  brand text. When no real vial exists yet, it falls back to the AI-rendered
  vial background.

Slugs with a real asset override generation everywhere automatically — no
other change needed once the PNG is in this folder.
