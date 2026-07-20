'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderLeadsHtml } = require('../lib/leads-dashboard');

const SAMPLE = {
  generatedAt: '2026-07-20T12:00:00Z',
  prospects: {
    total: 42, newToday: 3, newLast7Days: 11, suppressed: 4,
    byStage: [
      { stage: 'qualified', count: 7, avg_score: 72 },
      { stage: 'affiliate_applied', count: 5, avg_score: 61 }
    ],
    byCampaignLast7Days: [{ campaign_id: 'affiliate_applications', count: 6, avg_score: 64 }],
    topRated: [
      { name: 'Legacy Fit', score: 88, stage: 'qualified', campaign_id: 'sdr_beauty', created: '2026-07-19' },
      { name: 'Synthetic Studio', score: 74, stage: 'affiliate_applied', campaign_id: 'affiliate_applications', created: '2026-07-18' }
    ]
  },
  outreach: {
    queueByStatus: [{ status: 'awaiting_review', count: 3 }, { status: 'sent', count: 12 }],
    sentByDay: [{ day: '2026-07-20', channel: 'email', sent: 5 }]
  }
};

test('renders tiles, top leads, and breakdown tables from a digest', () => {
  const html = renderLeadsHtml(SAMPLE);
  assert.match(html, /Leads Dashboard/);
  assert.match(html, /Legacy Fit/);
  assert.match(html, /Synthetic Studio/);
  assert.match(html, /qualified/);
  assert.match(html, /affiliate_applications/);
  assert.match(html, /awaiting_review/);
  // Tile values present.
  assert.match(html, />42</);
  assert.match(html, />11</);
});

test('escapes HTML in business names (no injection)', () => {
  const html = renderLeadsHtml({
    prospects: { topRated: [{ name: '<script>alert(1)</script>', score: 10, stage: 's', campaign_id: 'c', created: 'd' }] },
    outreach: {}
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('renders gracefully with an empty digest', () => {
  const html = renderLeadsHtml({});
  assert.match(html, /Leads Dashboard/);
  assert.match(html, /No rows yet/);
  assert.match(html, />0</); // zero tiles
});
