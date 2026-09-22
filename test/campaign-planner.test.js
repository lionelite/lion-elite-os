const test = require('node:test');
const assert = require('node:assert/strict');
const { planCampaign } = require('../lib/platform/campaign-planner');

test('turns plain English into a meeting campaign', () => {
  const plan = planCampaign(
    'Find med spas in South Florida with 2-20 employees and book me calls by email',
    { offerName: 'AI Front Desk', offerDescription: 'Answers and books inbound leads' }
  );
  assert.equal(plan.objective, 'book_meetings');
  assert.equal(plan.icp.geography, 'South Florida');
  assert.deepEqual(plan.icp.employees, { min: 2, max: 20 });
  assert.deepEqual(plan.channels, ['email']);
  assert.equal(plan.intentThreshold, 4);
  assert.equal(plan.sendPolicy, 'supervised');
  assert.equal(plan.sequence[0].stopOnReply, true);
});

test('autopilot and threshold are explicit when requested', () => {
  const plan = planCampaign('Target dental groups in Florida, use email and LinkedIn, autopilot, intent 5');
  assert.equal(plan.sendPolicy, 'autopilot');
  assert.equal(plan.intentThreshold, 5);
  assert.deepEqual(plan.channels, ['email', 'linkedin']);
});