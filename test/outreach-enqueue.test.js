'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectOutreachCandidates, buildEmailJobContext, hasEmail } = require('../lib/outreach-enqueue');

const P = (over) => ({
  prospectId: over.id, status: 'active', stage: 'qualified',
  contact: { email: 'a@b.co' }, business: { name: 'Biz' }, score: 50, ...over
});

test('selects prospects with an email, not suppressed, not already contacted', () => {
  const prospects = [
    P({ id: '1', score: 80 }),
    P({ id: '2', status: 'suppressed' }),
    P({ id: '3', contact: {} }),               // no email
    P({ id: '4', stage: 'sent' }),             // already contacted
    P({ id: '5', stage: 'customer' }),         // terminal
    P({ id: '6', score: 90 })
  ];
  const { eligible, skipped } = selectOutreachCandidates(prospects);
  assert.deepEqual(eligible.map((p) => p.prospectId), ['6', '1']); // score-sorted
  const reasons = Object.fromEntries(skipped.map((s) => [s.prospectId, s.reason]));
  assert.equal(reasons['2'], 'suppressed');
  assert.equal(reasons['3'], 'no_email');
  assert.equal(reasons['4'], 'stage_sent');
  assert.equal(reasons['5'], 'stage_customer');
});

test('suppressed always beats other reasons; nothing suppressed is ever eligible', () => {
  const prospects = [P({ id: 's', status: 'suppressed', stage: 'qualified' })];
  const { eligible, skipped } = selectOutreachCandidates(prospects);
  assert.equal(eligible.length, 0);
  assert.equal(skipped[0].reason, 'suppressed');
});

test('hasEmail requires an @', () => {
  assert.equal(hasEmail({ contact: { email: 'x@y.z' } }), true);
  assert.equal(hasEmail({ contact: { email: 'nope' } }), false);
  assert.equal(hasEmail({ contact: {} }), false);
  assert.equal(hasEmail({}), false);
});

test('buildEmailJobContext maps stored fields to the email generator inputs', () => {
  const prospect = P({
    id: '7',
    business: { name: 'Legacy Fit', category: 'Gym', location: 'Miami, FL' },
    contact: { email: 'ops@legacyfit.co', name: 'Manning' },
    personalization: { suggestedAngle: 'affiliate partnership' }
  });
  const ctx = buildEmailJobContext(prospect);
  assert.equal(ctx.businessName, 'Legacy Fit');
  assert.equal(ctx.contactName, 'Manning');
  assert.equal(ctx.category, 'Gym');
  assert.equal(ctx.location, 'Miami, FL');
  assert.equal(ctx.partnershipAngle, 'affiliate partnership');
  assert.equal(ctx.prospect, prospect);
  assert.deepEqual(ctx.policy, {});
});

test('empty input yields no candidates', () => {
  assert.deepEqual(selectOutreachCandidates([]), { eligible: [], skipped: [] });
});
