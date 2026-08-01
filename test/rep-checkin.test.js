'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCheckin, performanceScore } = require('../rep-checkin-server');

test('performance score increases with activity and results', () => {
  const low = performanceScore({ leadsContacted: 5, followupsCompleted: 2, conversationsStarted: 1, consultationsBooked: 0, salesClosed: 0, revenueCents: 0, confidenceScore: 5 });
  const high = performanceScore({ leadsContacted: 50, followupsCompleted: 30, conversationsStarted: 12, consultationsBooked: 4, salesClosed: 3, revenueCents: 250000, confidenceScore: 9 });
  assert.ok(high > low);
  assert.ok(high <= 100);
});

test('normalizeCheckin validates rep and week', () => {
  assert.throws(() => normalizeCheckin({}), /REP_ID_REQUIRED/);
  assert.throws(() => normalizeCheckin({ repId: 'rep-1', weekStart: 'Friday' }), /VALID_WEEK_START_REQUIRED/);
});

test('normalizeCheckin clamps negative numbers and converts dollars to cents', () => {
  const result = normalizeCheckin({ repId: 'rep-1', weekStart: '2026-07-27', leadsContacted: -4, revenue: '125.50', confidenceScore: 20 });
  assert.equal(result.leadsContacted, 0);
  assert.equal(result.revenueCents, 12550);
  assert.equal(result.confidenceScore, 10);
});
