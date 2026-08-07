'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateRevenueSummary,
  calculatePipeline,
  evaluateSystemHealth,
  detectRevenueLeaks,
  generateExecutiveReport,
} = require('../revenue-intelligence');

const NOW = '2026-08-07T14:00:00.000Z';

test('calculates revenue pacing, attribution, brand, source, and forecast', () => {
  const events = [
    { id: 'o1', timestamp: '2026-08-07T13:00:00Z', amount: 500, brand: 'LEW', source: 'email' },
    { id: 'o2', timestamp: '2026-08-06T17:00:00Z', amount: 300, brand: 'LEB', source: 'organic', isRepeat: true },
    { id: 'o3', timestamp: '2026-08-05T17:00:00Z', amount: 200, brand: 'LEW', source: 'unknown' },
  ];

  const summary = calculateRevenueSummary(events, { now: NOW, monthlyTarget: 100000 });
  assert.equal(summary.revenueToday, 500);
  assert.equal(summary.revenueMTD, 1000);
  assert.equal(summary.ordersMTD, 3);
  assert.equal(summary.averageOrderValue, 333.33);
  assert.equal(summary.repeatRevenue, 300);
  assert.equal(summary.repeatRevenueSharePct, 30);
  assert.equal(summary.attributionCoveragePct, 80);
  assert.deepEqual(summary.byBrand, { LEW: 700, LEB: 300 });
  assert.deepEqual(summary.bySource, { email: 500, organic: 300, unknown: 200 });
  assert.equal(summary.projectedMonthRevenue, 4428.57);
  assert.ok(summary.requiredDailyPace > 0);
});

test('weights pipeline and prioritizes overdue expected value', () => {
  const leads = [
    {
      id: 'l1',
      name: 'Clinic A',
      status: 'proposal',
      estimatedValue: 4000,
      leadQuality: 0.9,
      nextActionDate: '2026-08-06T12:00:00Z',
      owner: 'alex',
      email: 'contact@example.com',
    },
    {
      id: 'l2',
      name: 'Client B',
      status: 'qualified',
      estimatedValue: 1000,
      leadQuality: 0.8,
      nextActionDate: '2026-08-07T16:00:00Z',
      owner: 'sales',
      phone: '+15555555555',
    },
  ];

  const pipeline = calculatePipeline(leads, { now: NOW });
  assert.equal(pipeline.totalLeads, 2);
  assert.equal(pipeline.qualifiedLeads, 2);
  assert.equal(pipeline.overdueFollowUps, 1);
  assert.equal(pipeline.dueToday, 1);
  assert.equal(pipeline.topOpportunities[0].id, 'l1');
  assert.ok(pipeline.weightedPipelineValue > 2000);
});

test('marks stale and failing systems as degraded or broken', () => {
  const health = evaluateSystemHealth([
    { name: 'shopify-sync', lastSuccessAt: '2026-08-07T13:30:00Z' },
    { name: 'lead-worker', lastSuccessAt: '2026-08-05T13:00:00Z' },
    { name: 'ads-sync', error: 'auth failed' },
  ], { now: NOW, staleAfterHours: 26 });

  assert.equal(health[0].status, 'verified');
  assert.equal(health[1].status, 'degraded');
  assert.equal(health[2].status, 'broken');
});

test('detects revenue gap, overdue follow-ups, attribution gap, and unhealthy systems', () => {
  const report = generateExecutiveReport({
    now: NOW,
    monthlyTarget: 100000,
    revenueEvents: [
      { timestamp: '2026-08-07T13:00:00Z', amount: 100, brand: 'LEW', source: 'unknown' },
    ],
    leads: [
      {
        id: 'l1',
        name: 'Clinic A',
        status: 'proposal',
        estimatedValue: 2000,
        leadQuality: 1,
        nextActionDate: '2026-08-06T12:00:00Z',
        email: 'contact@example.com',
      },
    ],
    systems: [{ name: 'shopify-sync', lastSuccessAt: '2026-08-01T12:00:00Z', owner: 'engineering' }],
  });

  const types = report.topRevenueLeaks.map((leak) => leak.type);
  assert.ok(types.includes('daily-revenue-gap') || types.includes('overdue-follow-ups'));
  assert.ok(report.dailyActions.length > 0);
  assert.equal(report.compliance.lionEliteWellness.includes('Research-use-only'), true);
});

test('leak detector returns an ordered list', () => {
  const summary = {
    dailyTarget: 1000,
    revenueToday: 0,
    revenueMTD: 1000,
    attributionCoveragePct: 50,
  };
  const pipeline = {
    overdueFollowUps: 2,
    overdueExpectedValue: 1500,
  };
  const leaks = detectRevenueLeaks(summary, pipeline, []);
  assert.equal(leaks[0].type, 'overdue-follow-ups');
  assert.equal(leaks[0].estimatedRecoverableRevenue, 1500);
});
