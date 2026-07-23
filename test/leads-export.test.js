'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactName, scoreBucket, scoreDistribution, sanitizeDigest, renderSummaryMarkdown } = require('../lib/leads-export');

const DIGEST = {
  generatedAt: '2026-07-22T12:00:00Z',
  prospects: {
    total: 24, newToday: 3, newLast7Days: 9, suppressed: 2,
    byStage: [{ stage: 'qualified', count: 6, avg_score: 74 }],
    byCampaignLast7Days: [{ campaign_id: 'affiliate_applications', count: 5, avg_score: 66 }],
    topRated: [
      { name: 'Legacy Fit', email: 'ops@legacyfit.co', score: 88, stage: 'qualified', campaign_id: 'sdr_beauty', created: '2026-07-21' },
      { name: 'Peak Performance Labs', email: 'hi@peak.co', score: 55, stage: 'affiliate_applied', campaign_id: 'affiliate_applications', created: '2026-07-20' },
      { name: 'Small Shop', score: 32, stage: 'discovered', campaign_id: 'sdr_lionos', created: '2026-07-19' }
    ]
  },
  outreach: { queueByStatus: [{ status: 'sent', count: 12 }], sentByDay: [{ day: '2026-07-22', channel: 'email', sent: 4 }] }
};

test('redactName reduces to non-identifying initials', () => {
  assert.equal(redactName('Legacy Fit'), 'L.F.');
  assert.equal(redactName('Peak Performance Labs'), 'P.P.L.');
  assert.equal(redactName(''), '—');
});

test('score buckets classify correctly', () => {
  assert.equal(scoreBucket(88), 'strong_70_plus');
  assert.equal(scoreBucket(55), 'medium_40_69');
  assert.equal(scoreBucket(10), 'weak_0_39');
  assert.equal(scoreBucket(null), 'unscored');
});

test('sanitizeDigest strips names and emails but keeps aggregates', () => {
  const s = sanitizeDigest(DIGEST);
  const serialized = JSON.stringify(s);
  // No customer PII survives (names or email addresses).
  assert.doesNotMatch(serialized, /Legacy Fit|Peak Performance|Small Shop/);
  assert.doesNotMatch(serialized, /@|legacyfit|peak\.co/); // no email addresses
  // Aggregates and redacted rows survive.
  assert.equal(s.prospects.total, 24);
  assert.equal(s.prospects.topRatedRedacted[0].initials, 'L.F.');
  assert.equal(s.prospects.topRatedRedacted[0].score, 88);
  assert.deepEqual(s.prospects.scoreDistribution, { strong_70_plus: 1, medium_40_69: 1, weak_0_39: 1, unscored: 0 });
  assert.equal(s.sanitized, true);
});

test('scoreDistribution counts across buckets', () => {
  assert.deepEqual(
    scoreDistribution([{ score: 90 }, { score: 71 }, { score: 50 }, { score: 5 }]),
    { strong_70_plus: 2, medium_40_69: 1, weak_0_39: 1, unscored: 0 }
  );
});

test('markdown summary renders without leaking PII', () => {
  const md = renderSummaryMarkdown(sanitizeDigest(DIGEST));
  assert.match(md, /Leads Export \(sanitized\)/);
  assert.match(md, /Total prospects:\*\* 24/);
  assert.match(md, /L\.F\./);
  assert.doesNotMatch(md, /Legacy Fit|legacyfit\.co/);
});

test('handles an empty digest gracefully', () => {
  const s = sanitizeDigest({});
  assert.equal(s.prospects.total, 0);
  assert.match(renderSummaryMarkdown(s), /Total prospects:\*\* 0/);
});
