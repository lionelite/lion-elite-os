const test = require('node:test');
const assert = require('node:assert/strict');
const { getPlan, ADD_ONS } = require('../lib/platform/plans');

test('Solo plan is $299 monthly and $2,990 annual', () => {
  const plan = getPlan('solo');
  assert.equal(plan.monthlyPrice, 299);
  assert.equal(plan.annualPrice, 2990);
  assert.equal(plan.seats, 1);
  assert.equal(plan.dataCredits, 3000);
  assert.equal(plan.actionCredits, 5000);
});

test('Agency plan is $499 monthly and $4,990 annual', () => {
  const plan = getPlan('agency');
  assert.equal(plan.monthlyPrice, 499);
  assert.equal(plan.annualPrice, 4990);
  assert.equal(plan.seats, 5);
  assert.equal(plan.clientWorkspaces, 5);
  assert.equal(plan.dataCredits, 6000);
  assert.equal(plan.actionCredits, 12000);
  assert.equal(plan.whiteLabel, true);
});

test('add-on prices stay aligned with the launch model', () => {
  assert.equal(ADD_ONS.channelConnectionMonthlyCents, 1200);
  assert.equal(ADD_ONS.clientWorkspaceMonthlyCents, 9900);
  assert.equal(ADD_ONS.seatMonthlyCents, 1900);
});
