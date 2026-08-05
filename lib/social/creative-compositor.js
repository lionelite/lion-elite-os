'use strict';

// Brand text-overlay compositor (approach B). Takes an AI-generated
// cinematic background (lion + integrated vial, no text) and composites the
// crisp brand typography over it as REAL vector text — headline, wordmark,
// research-pathway column, and the research-use-only bottom bar — so the
// text is always sharp and correct, never AI-garbled.
//
// Output matches the "WHAT IS <PEPTIDE>?" reference: black/gold/savanna,
// white+gold headline, gold pathway chips, RUO bar. sharp renders the SVG
// via librsvg; fonts fall back to DejaVu Sans (present on the CI runner).

const sharp = require('sharp');
const { BOTTOM_BAR } = require('./creative-template');

const WIDTH = 1080;
const HEIGHT = 1350;
const GOLD = '#C9A24B';
const FONT = "Arial, 'DejaVu Sans', 'Liberation Sans', sans-serif";

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// "WHAT IS RETATRUTIDE?" -> { line1: "WHAT IS", line2: "RETATRUTIDE?" } so
// line1 renders white and line2 gold, like the reference.
function splitHeadline(headline) {
  const m = String(headline).match(/^(WHAT IS)\s+(.*)$/i);
  return m ? { line1: m[1], line2: m[2] } : { line1: headline, line2: '' };
}

function buildOverlaySvg({ headline, pathways = [], wordmark = 'LION ELITE WELLNESS', bottomBar = BOTTOM_BAR }) {
  const { line1, line2 } = splitHeadline(headline);
  const pathwayRows = pathways.slice(0, 4).map((label, i) => {
    const y = 700 + i * 92;
    return `
      <circle cx="82" cy="${y - 14}" r="20" fill="none" stroke="${GOLD}" stroke-width="3"/>
      <circle cx="82" cy="${y - 14}" r="7" fill="${GOLD}"/>
      <text x="130" y="${y}" font-family="${FONT}" font-size="34" font-weight="bold" fill="#ffffff">${escapeXml(label)}</text>`;
  }).join('');

  return Buffer.from(`<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#000000" stop-opacity="0.72"/>
      <stop offset="0.55" stop-color="#000000" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="url(#scrim)"/>
  <!-- wordmark -->
  <text x="60" y="90" font-family="${FONT}" font-size="34" font-weight="bold" letter-spacing="3" fill="${GOLD}">${escapeXml(wordmark)}</text>
  <!-- headline -->
  <text x="58" y="300" font-family="${FONT}" font-size="96" font-weight="bold" fill="#ffffff">${escapeXml(line1)}</text>
  <text x="58" y="405" font-family="${FONT}" font-size="96" font-weight="bold" fill="${GOLD}">${escapeXml(line2)}</text>
  <rect x="60" y="440" width="240" height="5" fill="${GOLD}"/>
  <!-- pathway column -->
  ${pathwayRows}
  <!-- bottom RUO bar -->
  <rect x="0" y="${HEIGHT - 96}" width="${WIDTH}" height="96" fill="#000000" fill-opacity="0.82"/>
  <rect x="0" y="${HEIGHT - 96}" width="${WIDTH}" height="4" fill="${GOLD}"/>
  <text x="${WIDTH / 2}" y="${HEIGHT - 40}" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="bold" letter-spacing="2" fill="${GOLD}">${escapeXml(bottomBar)}</text>
</svg>`);
}

// The real vial is composited into the lower-right, sitting on the pedestal
// the background prompt reserves. Sized as a fraction of canvas height and
// inset from the edges so it reads as "on the rock", not stuck to the border.
const VIAL_HEIGHT_RATIO = 0.42;
const VIAL_MARGIN_RIGHT = 70;
const VIAL_MARGIN_BOTTOM = 120; // clears the RUO bar

/**
 * Prepare the real vial for compositing: resize to a target height keeping
 * aspect ratio, on a transparent canvas. Returns { buffer, width, height }
 * or null if the vial can't be read.
 */
async function prepareVial(vialBuffer) {
  if (!Buffer.isBuffer(vialBuffer) || vialBuffer.length === 0) return null;
  const targetH = Math.round(HEIGHT * VIAL_HEIGHT_RATIO);
  const resized = await sharp(vialBuffer)
    .resize({ height: targetH, fit: 'inside', withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(resized).metadata();
  return { buffer: resized, width: meta.width, height: meta.height };
}

/**
 * Composite the brand text over an AI background buffer. Returns a final
 * JPEG buffer at 1080x1350. Background is resized/cropped to fill.
 *
 * When `vialBuffer` is supplied (the real branded product image from
 * lib/social/vial-registry.js, ideally a transparent-background PNG), it is
 * composited into the lower-right BEFORE the text overlay so the correct
 * product always appears — never an AI-rendered or mismatched vial.
 */
async function composeCreative({ backgroundBuffer, headline, pathways, wordmark, bottomBar, vialBuffer }) {
  if (!Buffer.isBuffer(backgroundBuffer) || backgroundBuffer.length === 0) {
    throw new Error('composeCreative requires a non-empty background buffer.');
  }
  const base = await sharp(backgroundBuffer)
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
    .toBuffer();

  const layers = [];
  const vial = await prepareVial(vialBuffer);
  if (vial) {
    layers.push({
      input: vial.buffer,
      top: HEIGHT - vial.height - VIAL_MARGIN_BOTTOM,
      left: WIDTH - vial.width - VIAL_MARGIN_RIGHT
    });
  }
  // Text overlay goes last so headline/pathways/RUO bar stay on top.
  layers.push({ input: buildOverlaySvg({ headline, pathways, wordmark, bottomBar }), top: 0, left: 0 });

  return sharp(base)
    .composite(layers)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

module.exports = { WIDTH, HEIGHT, splitHeadline, buildOverlaySvg, composeCreative, prepareVial };
