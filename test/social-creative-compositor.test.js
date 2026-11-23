'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { splitHeadline, buildOverlaySvg, composeCreative, prepareVial, WIDTH, HEIGHT } = require('../lib/social/creative-compositor');

async function placeholderBackground() {
  return sharp({ create: { width: 1200, height: 1500, channels: 3, background: { r: 30, g: 22, b: 10 } } })
    .png().toBuffer();
}

async function placeholderVial() {
  // A tall translucent product-shaped rectangle on a transparent canvas.
  return sharp({ create: { width: 200, height: 620, channels: 4, background: { r: 200, g: 160, b: 70, alpha: 1 } } })
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

test('prepareVial resizes to the target height and returns dimensions', async () => {
  const prepared = await prepareVial(await placeholderVial());
  assert.ok(prepared, 'expected a prepared vial');
  assert.equal(prepared.height, Math.round(HEIGHT * 0.42));
  assert.ok(prepared.width > 0);
  assert.ok(Buffer.isBuffer(prepared.buffer));
});

test('prepareVial returns null for empty/absent vial buffers', async () => {
  assert.equal(await prepareVial(Buffer.alloc(0)), null);
  assert.equal(await prepareVial(undefined), null);
});

test('composeCreative composites a real vial and still produces a valid JPEG', async () => {
  const withVial = await composeCreative({
    backgroundBuffer: await placeholderBackground(),
    headline: 'WHAT IS RETATRUTIDE?',
    pathways: ['Metabolic', 'Receptor Signaling'],
    vialBuffer: await placeholderVial()
  });
  const withoutVial = await composeCreative({
    backgroundBuffer: await placeholderBackground(),
    headline: 'WHAT IS RETATRUTIDE?',
    pathways: ['Metabolic', 'Receptor Signaling']
  });
  const meta = await sharp(withVial).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, WIDTH);
  assert.equal(meta.height, HEIGHT);
  // The composited vial changes pixels, so the two encodings differ.
  assert.notEqual(withVial.length, withoutVial.length);
});
