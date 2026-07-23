# Lion Elite Wellness — Creative Standard

The brand creative bar, captured from the high-performing **"WHAT IS
RETATRUTIDE?"** post (354 views) — the opposite of the broken pasted-vial
posts (16 views, wrong product, text covered). Every peptide creative
targets this; each gets **unique flair** so the feed feels designed.

## The template

| Zone | Content |
|---|---|
| Top-left | Lion Elite Wellness gold lion-head logo + wordmark |
| Headline (upper-left) | **WHAT IS [PEPTIDE]?** — bold condensed, white + gold |
| Left column | 2–4 gold circular research-pathway icons + short labels, fully legible |
| Hero | Cinematic **male lion in a golden-hour savanna** (the brand motif) |
| Product | A **photorealistic branded vial** — `LION ELITE WELLNESS / [PEPTIDE] / 10 MG / RESEARCH USE ONLY` — **integrated into the scene** (on a rock, matched light), never pasted flat over text |
| Bottom bar | `SCIENCE · EDUCATION · TRUTH — FOR RESEARCH USE ONLY` + lion crest |
| Palette | Deep black/charcoal + metallic gold (#C9A24B) + warm savanna amber + white text |
| Mood | Premium, cinematic, authoritative — National Geographic meets luxury pharma |

**Unique flair per post:** the lion scene rotates across 8 variations
(walking toward camera, atop a kopje, resting on a ledge, mid-stride,
profile at sunset, portrait, surveying the plains, close dusk portrait) so
no two posts look stamped. Codified in `lib/social/creative-template.js`
(`FLAIR_SCENES`), paired to each peptide by index.

## What the broken posts got wrong (do not repeat)

1. **Wrong product asset** — a SELANK vial on a CJC-1295 post. The new
   pipeline makes this **structurally impossible**: each creative's vial
   label and headline are derived from the post's own peptide
   (`test/social-creative-template.test.js` asserts every peptide names its
   own product).
2. **Vial pasted over the text** — a flat white product photo dumped on top
   of the body copy. The standard requires the vial **composed into the
   scene** with negative space kept clear for text.

## How to produce it (important: text reliability)

The cinematic **background + integrated vial** is generated from the prompt
in `lib/social/creative-template.js` (`buildCreativePrompt`) via the
media-hosting image pipeline (`AI_IMAGE_ENABLED` + `gpt-image-1`). That part
automates well.

**The headline / pathway / label TEXT is the catch:** AI image models render
long text unreliably (garbled words). The reference post's text is crisp
because it was laid over the AI background with a design template. So for
production-grade posts, two options:

- **Recommended — background from AI, text from a brand template.** Generate
  the lion+vial background here, then composite the headline, pathway icons,
  RUO bar, and logo with a **Canva brand kit** (or an SVG/HTML → PNG
  renderer). Reliable, pixel-perfect text; still one asset per post.
- **Fully-AI (fast, lower text fidelity).** Let `gpt-image-1` render the
  whole thing from the prompt. Fine for the scene and vial; proofread the
  text before it goes to Metricool.

Either way the **product-to-post mapping is locked** in code, so the
wrong-vial bug can't recur, and one clean composed image per post replaces
the broken overlay.

## Where this plugs in

`lib/social/peptide-catalog.js` now builds every peptide's `imagePrompt`
from this standard. The media-hosting layer hosts one image per post at a
stable URL → Metricool `Picture Url 1` / the auto-publisher. Drop a
designer/Canva-finished JPEG at `content/media/<date>/<piece-id>.jpg` and it
wins over generation (human asset always preferred).
