'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { splitHeadline, buildOverlaySvg, composeCreative, WIDTH, HEIGHT } = require('../lib/social/creative-compositor');

async function placeholderBackground() {
  return sharp({ create: { width: 1200, height: 1500, channels: 3, background: { r: 30, g: 22, b: 10 } } })
    .png().toBuffer();
}

test('splitHeadline separates WHAT IS from the product for two-color rendering', () => {
  assert.deepEqual(splitHeadline('WHAT IS RETATRUTIDE?'), { line1: 'WHAT IS', line2: 'RETATRUTIDE?' });
  assert.deepEqual(splitHeadline('SOMETHING ELSE'), { line1: 'SOMETHING ELSE', line2: '' });
});

test('overlay SVG contains the headline, pathways, and RUO bar, and escapes XML', () => {
  const svg = buildOverlaySvg({ headline: 'WHAT IS BPC-157?', pathways: ['Gut & Tissue', 'Repair'] }).toString();
  assert.match(svg, /WHAT IS/);
  assert.match(svg, /BPC-157\?/);
  assert.match(svg, /Gut &amp; Tissue/); // XML-escaped ampersand
  assert.match(svg, /FOR RESEARCH USE ONLY/);
});

test('composeCreative produces a 1080x1350 JPEG from a background + text', async () => {
  const out = await composeCreative({
    backgroundBuffer: await placeholderBackground(),
    headline: 'WHAT IS RETATRUTIDE?',
    pathways: ['Metabolic', 'Receptor Signaling', 'Energy Balance']
  });
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, WIDTH);
  assert.equal(meta.height, HEIGHT);
  assert.ok(out.length > 10000, 'expected a non-trivial image');
});

test('composeCreative rejects an empty background', async () => {
  await assert.rejects(
    () => composeCreative({ backgroundBuffer: Buffer.alloc(0), headline: 'x', pathways: [] }),
    /non-empty background/
  );
});
