'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  newLedger, addCandidate, startTest, recordResult, confirm, retire, confirmedSOPs, byStatus
} = require('../src/sop-ledger');

function seeded() {
  const l = newLedger();
  addCandidate(l, { patternId: 'lever:landing-page-testing', statement: 'test LP', evidence: ['Cornbread Hemp', 'Healthy Metal'] });
  return l;
}

test('addCandidate is idempotent and stores borrowed evidence separately', () => {
  const l = seeded();
  addCandidate(l, { patternId: 'lever:landing-page-testing', statement: 'dup' });
  const p = l.patterns['lever:landing-page-testing'];
  assert.equal(Object.keys(l.patterns).length, 1);
  assert.deepEqual(p.borrowedEvidence, ['Cornbread Hemp', 'Healthy Metal']);
  assert.deepEqual(p.ourResults, []);
  assert.equal(p.status, 'candidate');
});

test('cannot confirm a candidate without testing and our own result', () => {
  const l = seeded();
  assert.throws(() => confirm(l, 'lever:landing-page-testing'), /Confirm only from testing/);
});

test('cannot confirm from testing with no positive Lion Elite result', () => {
  const l = seeded();
  startTest(l, 'lever:landing-page-testing', { campaign: 'LEW-LP-Q3' });
  assert.throws(() => confirm(l, 'lever:landing-page-testing'), /no positive Lion Elite result/);
});

test('full lifecycle: candidate → testing → (our result) → confirmed', () => {
  const l = seeded();
  startTest(l, 'lever:landing-page-testing', { campaign: 'LEW-LP-Q3', hypothesis: 'congruent LP lifts CVR' });
  assert.equal(byStatus(l, 'testing').length, 1);
  recordResult(l, 'lever:landing-page-testing', { metric: 'conversion_rate', value: 22, direction: 'increase', good: true, campaign: 'LEW-LP-Q3' });
  confirm(l, 'lever:landing-page-testing', 'validated on our traffic');
  const sops = confirmedSOPs(l);
  assert.equal(sops.length, 1);
  assert.equal(sops[0].patternId, 'lever:landing-page-testing');
  assert.equal(sops[0].ourResults.length, 1);
});

test('a negative own result does not let it confirm', () => {
  const l = seeded();
  startTest(l, 'lever:landing-page-testing', {});
  recordResult(l, 'lever:landing-page-testing', { metric: 'conversion_rate', value: -5, direction: 'decrease', good: false });
  assert.throws(() => confirm(l, 'lever:landing-page-testing'), /no positive Lion Elite result/);
});

test('startTest only from candidate; recordResult needs metric + numeric value', () => {
  const l = seeded();
  startTest(l, 'lever:landing-page-testing', {});
  assert.throws(() => startTest(l, 'lever:landing-page-testing', {}), /Can only test a candidate/);
  assert.throws(() => recordResult(l, 'lever:landing-page-testing', { metric: 'x' }), /numeric value/);
});

test('retire works from any status and is reflected in byStatus', () => {
  const l = seeded();
  retire(l, 'lever:landing-page-testing', 'did not replicate');
  assert.equal(byStatus(l, 'retired').length, 1);
  assert.equal(confirmedSOPs(l).length, 0);
});

test('unknown pattern id throws', () => {
  const l = newLedger();
  assert.throws(() => startTest(l, 'nope', {}), /Unknown pattern/);
});
