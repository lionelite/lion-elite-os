'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCreativePrompt, headlineFor, flairForIndex, FLAIR_SCENES } = require('../lib/social/creative-template');
const { PEPTIDE_CATALOG } = require('../lib/social/peptide-catalog');

test('headlineFor produces the WHAT IS <PEPTIDE>? headline', () => {
  assert.equal(headlineFor('Retatrutide'), 'WHAT IS RETATRUTIDE?');
});

test('buildCreativePrompt hits the brand standard: lion, integrated vial, headline, RUO bar', () => {
  const prompt = buildCreativePrompt({
    name: 'Retatrutide', headline: 'WHAT IS RETATRUTIDE?',
    pathways: ['GLP-1', 'GIP', 'Glucagon'], flair: FLAIR_SCENES[0]
  });
  assert.match(prompt, /male lion/i);
  assert.match(prompt, /LION ELITE WELLNESS \/ RETATRUTIDE \/ 10 MG \/ RESEARCH USE ONLY/);
  assert.match(prompt, /integrated into the environment, NOT pasted flat/i);
  assert.match(prompt, /WHAT IS RETATRUTIDE\?/);
  assert.match(prompt, /GLP-1, GIP, Glucagon/);
  assert.match(prompt, /FOR RESEARCH USE ONLY/);
  assert.match(prompt, /no people, no human use/i);
});

test('flairForIndex cycles deterministically and covers all scenes', () => {
  assert.equal(flairForIndex(0), FLAIR_SCENES[0]);
  assert.equal(flairForIndex(FLAIR_SCENES.length), FLAIR_SCENES[0]);
  assert.equal(flairForIndex(1), FLAIR_SCENES[1]);
});

test('every catalog peptide names ITS OWN product on the vial (no mismatch)', () => {
  for (const p of PEPTIDE_CATALOG) {
    // The vial label must carry this peptide's name — the SELANK-on-CJC
    // class of bug is structurally impossible: prompt is derived per item.
    assert.ok(p.imagePrompt.includes(`/ ${p.name.toUpperCase()} /`), `${p.name} vial label mismatch`);
    assert.ok(p.imagePrompt.includes(`WHAT IS ${p.name.toUpperCase()}?`), `${p.name} headline mismatch`);
    assert.match(p.imagePrompt, /male lion/i);
    assert.match(p.imagePrompt, /FOR RESEARCH USE ONLY/);
  }
});

test('consecutive peptides get distinct flair scenes', () => {
  const first8 = PEPTIDE_CATALOG.slice(0, 8).map((p) => p.imagePrompt.match(/Scene: ([^.]+)/)[1]);
  assert.equal(new Set(first8).size, 8);
});
