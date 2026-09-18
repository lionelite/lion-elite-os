const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement } = require('../src/engagement');
const { buildProposal, buildInternalPlan, buildTicketIssue, assertNoInternalLeakage } = require('../src/proposal');

const EXAMPLES = path.join(__dirname, '..', 'examples');
function example(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
}
const CEDAR = planEngagement(example('cedar-roofing.json'));

test('the proposal leads with the client value case', () => {
  const md = buildProposal(CEDAR);
  assert.match(md, /## The problem, in your numbers/);
  assert.match(md, /Revenue recovered/);
  assert.ok(md.indexOf('The problem, in your numbers') < md.indexOf('## Investment'),
    'the problem must be established before the price');
});

test('the proposal never leaks delivery cost, margin, or the word contractor', () => {
  const md = buildProposal(CEDAR);
  assert.ok(!/contractor/i.test(md));
  assert.ok(!/gross (margin|profit)/i.test(md));
  assert.ok(!md.includes(String(CEDAR.economics.developerCost)));
  assert.ok(!md.includes(CEDAR.economics.developerCost.toLocaleString('en-US')));
  assert.ok(!md.includes(CEDAR.economics.grossProfit.toLocaleString('en-US')));
  for (const t of CEDAR.deliveryPlan.tickets) {
    assert.ok(!new RegExp(`\\$${t.fixedPrice}\\b`).test(md), `ticket price ${t.fixedPrice} leaked`);
  }
});

test('every example proposal passes the leakage guard', () => {
  for (const file of fs.readdirSync(EXAMPLES)) {
    const e = planEngagement(example(file));
    if (!e.proceed) continue;
    assert.doesNotThrow(() => buildProposal(e), file);
  }
});

test('the leakage guard actually catches a leak', () => {
  assert.throws(() => assertNoInternalLeakage('We pay our contractor $5,000.', [5000]), /leaks internal detail/);
  assert.throws(() => assertNoInternalLeakage('Our gross margin is healthy.'), /internal term/);
  assert.throws(() => assertNoInternalLeakage('Delivery costs us $7,700.', [7700]), /internal figure/);
});

test('the leakage guard passes a clean document', () => {
  assert.equal(assertNoInternalLeakage('The build is $21,000 and pays back in 2.2 months.', [7700, 1600]), true);
});

test('the proposal states the price, deposit and payback in the client\'s terms', () => {
  const md = buildProposal(CEDAR);
  assert.ok(md.includes(CEDAR.economics.projectPrice.toLocaleString('en-US')));
  assert.ok(md.includes(CEDAR.economics.depositAmount.toLocaleString('en-US')));
  assert.match(md, /pays for itself in \*\*[\d.]+ months\*\*/);
  assert.match(md, /The price is fixed\. It does not move with hours spent\./);
});

test('the proposal states its own assumptions rather than hiding them', () => {
  const md = buildProposal(CEDAR);
  assert.match(md, /How these numbers were built/);
  assert.match(md, /60% of your normal close rate/);
  assert.match(md, /35%/);
});

test('the proposal refuses to guarantee revenue and lists exclusions', () => {
  const md = buildProposal(CEDAR);
  assert.match(md, /We do not guarantee a revenue figure/);
  assert.match(md, /## What is not included/);
});

test('every milestone appears with its acceptance criteria', () => {
  const md = buildProposal(CEDAR);
  for (const m of CEDAR.deliveryPlan.milestones) {
    assert.ok(md.includes(m.name), `${m.id} missing`);
    for (const t of m.acceptanceTests) assert.ok(md.includes(t.statement), `${t.id} missing`);
  }
});

test('a proposal cannot be built for an engagement that is not ready', () => {
  const blocked = planEngagement(example('corner-cafe-disqualified.json'));
  assert.throws(() => buildProposal(blocked), /not ready to propose/);
});

test('the internal plan carries exactly what the proposal omits', () => {
  const md = buildInternalPlan(CEDAR);
  assert.match(md, /Internal only/);
  assert.ok(md.includes(CEDAR.economics.developerCost.toLocaleString('en-US')));
  assert.ok(md.includes(CEDAR.economics.grossProfit.toLocaleString('en-US')));
  assert.match(md, /Gross margin/);
  assert.match(md, /## Cash flow/);
  assert.match(md, /## Contractor access/);
});

test('the internal plan works for a disqualified prospect too', () => {
  const md = buildInternalPlan(planEngagement(example('corner-cafe-disqualified.json')));
  assert.match(md, /## Blockers/);
  assert.match(md, /disqualified at qualification/);
});

test('the internal plan surfaces owner decisions', () => {
  const md = buildInternalPlan(planEngagement(example('summit-energy-services.json')));
  assert.match(md, /## Owner decisions required/);
});

test('a ticket body gives the contractor the work and their own price only', () => {
  const ticket = CEDAR.deliveryPlan.tickets[0];
  const md = buildTicketIssue(ticket, CEDAR);
  assert.ok(md.includes(ticket.title));
  assert.ok(md.includes(ticket.fixedPrice.toLocaleString('en-US')));
  for (const c of ticket.acceptanceCriteria) assert.ok(md.includes(c));
  // The commercial context is not theirs.
  assert.ok(!md.includes(CEDAR.clientName), 'the client name must not reach the ticket');
  assert.ok(!md.includes(CEDAR.economics.projectPrice.toLocaleString('en-US')), 'the client price must not reach the ticket');
  for (const other of CEDAR.deliveryPlan.tickets.slice(1)) {
    assert.ok(!md.includes(other.title), 'other tickets must not be visible');
  }
});

test('every ticket body states the fixed-price and channel rules', () => {
  for (const ticket of CEDAR.deliveryPlan.tickets) {
    const md = buildTicketIssue(ticket, CEDAR);
    assert.match(md, /paid on acceptance, not on hours/);
    assert.match(md, /Do not contact, quote, invoice or propose work to the end client/);
    assert.match(md, /Pull request opened against the integration branch \(do not merge\)/);
    assert.match(md, /No credential, key or token/);
  }
});

test('a regulated ticket carries its restrictions to the contractor', () => {
  const dental = planEngagement(example('lakeside-dental.json'));
  const md = buildTicketIssue(dental.deliveryPlan.tickets[0], dental);
  assert.match(md, /Restrictions on this engagement/);
  assert.match(md, /protected health information/i);
});

test('a ticket without an access plan is refused', () => {
  assert.throws(() => buildTicketIssue({ id: 'x', fixedPrice: 1, title: 't', summary: 's', acceptanceCriteria: [] }, CEDAR), /no access plan/);
});
