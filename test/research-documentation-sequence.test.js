'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSequence } = require('../lib/outreach/research-documentation-sequence');

test('the sequence is four emails, Day 1/7/14/30', () => {
  const seq = buildSequence();
  assert.deepEqual(seq.map((e) => e.day), [1, 7, 14, 30]);
});

test('every email passes RUO compliance and carries the research disclaimer', () => {
  for (const e of buildSequence()) {
    assert.equal(e.approved, true, `Day ${e.day}: ${JSON.stringify(e.compliance.blockers)}`);
    assert.match(e.text, /laboratory research purposes only/);
  }
});

test('no email contains human-use, dosing, or benefit language', () => {
  for (const e of buildSequence()) {
    assert.doesNotMatch(e.text, /inject|\bdose\b|\bmg\b|your protocol|take it|weight loss|muscle growth|boost your|improve your|you will (feel|see|notice)/i);
  }
});

test('each email HTML has a CTA link, batch/COA framing, and CAN-SPAM footer', () => {
  for (const e of buildSequence()) {
    assert.match(e.html, /href=/);
    assert.match(e.html, /\{\{unsubscribe_url\}\}/);
    assert.match(e.html, /\{\{postal_address\}\}/);
  }
  // The documentation angle (COA / batch / purity / test) is present across the set.
  const all = buildSequence().map((e) => e.text).join(' ').toLowerCase();
  for (const term of ['certificate of analysis', 'batch number', 'purity', 'test']) {
    assert.ok(all.includes(term), `missing "${term}" across the sequence`);
  }
});
