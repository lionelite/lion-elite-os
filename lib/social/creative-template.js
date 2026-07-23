'use strict';

// Lion Elite Wellness brand creative standard, captured from the
// high-performing "WHAT IS RETATRUTIDE?" post (354 views vs. 16 on the
// broken pasted-vial one). Every peptide creative targets this look; each
// gets a distinct "flair" scene so the feed feels designed, not stamped.
//
// The layout is a cinematic editorial poster:
//   - Lion Elite gold lion logo, top-left
//   - Bold "WHAT IS <PEPTIDE>?" headline (white + gold), upper-left
//   - Left column: 3 gold research-pathway icons + short labels
//   - A photorealistic branded vial integrated INTO the scene (on a rock,
//     matching light) — never pasted flat on top of text
//   - Bottom bar: SCIENCE · EDUCATION · TRUTH  |  FOR RESEARCH USE ONLY
//   - Palette: deep black/charcoal + gold + warm savanna, white text
//
// NOTE ON TEXT: AI image models render long text unreliably. For pixel-
// perfect headline/pathway/label text like the reference post, generate the
// cinematic background+vial here and lay the text over it with a brand
// template (Canva brand kit or an SVG/HTML compositor). See
// docs/social-creative-standard.md.

// Distinct lion/savanna scenes so no two posts look identical. Cycled by
// index; the pairing of scene + peptide keeps the set feeling varied.
const FLAIR_SCENES = Object.freeze([
  'a powerful male lion walking toward camera through golden savanna grass, dramatic sunset backlight',
  'a majestic male lion standing on a rocky kopje overlooking the savanna at golden hour',
  'a regal male lion resting on a warm stone ledge, acacia trees silhouetted against a burning sunset',
  'a male lion mid-stride through tall amber grass, low sun flare and floating dust',
  'a male lion in noble profile atop a boulder, sun setting behind a rim-lit mane',
  'a male lion facing the camera with a glowing golden-hour mane rim-light, savanna bokeh behind',
  'a male lion surveying the plains from a high rock, sweeping savanna vista and warm clouds',
  'a close cinematic portrait of a male lion at dusk, deep shadows and gold highlights'
]);

const BOTTOM_BAR = 'SCIENCE · EDUCATION · TRUTH   —   FOR RESEARCH USE ONLY';

function flairForIndex(i) {
  return FLAIR_SCENES[((i % FLAIR_SCENES.length) + FLAIR_SCENES.length) % FLAIR_SCENES.length];
}

/**
 * Build the art-direction prompt for one peptide creative.
 * @param {object} p
 * @param {string} p.name       product name (e.g. "Retatrutide")
 * @param {string} p.headline   e.g. "WHAT IS RETATRUTIDE?"
 * @param {string[]} p.pathways 2-4 short research-pathway labels for the left column
 * @param {string} p.flair      a scene from FLAIR_SCENES
 * @param {string} [p.format]   aspect ratio note (default vertical 4:5)
 */
function buildCreativePrompt({ name, headline, pathways = [], flair, format = 'vertical 4:5, 1080x1350' }) {
  const pathwayText = pathways.length
    ? `Left column: ${Math.min(pathways.length, 4)} gold circular research-pathway icons with short labels (${pathways.slice(0, 4).join(', ')}), clean and fully legible, never covered.`
    : 'Left column: gold circular research-pathway icons with short labels, clean and legible.';

  return [
    `${format} premium cinematic editorial poster for Lion Elite Wellness, National-Geographic-meets-luxury-pharma.`,
    `Scene: ${flair}. Warm golden-hour light, deep blacks and charcoal, rich gold accents, sharp and photorealistic, high dynamic range.`,
    `A photorealistic small glass research vial with a black-and-gold "LION ELITE WELLNESS / ${name.toUpperCase()} / 10 MG / RESEARCH USE ONLY" label sits naturally on a rock in the foreground, lit to match the scene — integrated into the environment, NOT pasted flat on top.`,
    'Top-left: the Lion Elite Wellness gold lion-head logo and wordmark.',
    `Upper-left headline in bold condensed type, white and gold: "${headline}".`,
    pathwayText,
    `A slim bottom bar reads: "${BOTTOM_BAR}" with a small gold lion crest.`,
    'Palette: deep black/charcoal background, metallic gold (#C9A24B), warm savanna amber, crisp white text. Mood: premium, authoritative, disciplined, editorial.',
    'Research-use-only aesthetic: no people, no human use, no medical or treatment imagery, no needles. Elegant negative space so all text stays legible.'
  ].join(' ');
}

function headlineFor(name) {
  return `WHAT IS ${String(name).toUpperCase()}?`;
}

module.exports = {
  FLAIR_SCENES,
  BOTTOM_BAR,
  flairForIndex,
  buildCreativePrompt,
  headlineFor
};
