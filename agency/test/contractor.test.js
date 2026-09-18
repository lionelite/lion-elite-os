const test = require('node:test');
const assert = require('node:assert/strict');
const { assignmentEligibility, assignTicket, reviewContractorMessage, onboardingChecklist, BASE_AGREEMENTS } = require('../src/contractor');
const { accessPlanForTicket } = require('../src/access');

function signed(ids, extra = {}) {
  const agreements = {};
  for (const id of ids) agreements[id] = { signedAt: '2026-01-15T00:00:00Z' };
  return { id: 'dev-001', agreements, paymentDetailsOnFile: true, ...extra };
}

const READY = signed(BASE_AGREEMENTS);

function ticket(tier = 'sandbox', flags = []) {
  const t = { id: 'acme-follow-up-sequence-engine', accessTier: tier, fixedPrice: 775 };
  t.accessPlan = accessPlanForTicket(t, flags);
  return t;
}

test('a fully papered contractor is eligible', () => {
  const e = assignmentEligibility(READY);
  assert.equal(e.eligible, true);
  assert.deepEqual(e.blockers, []);
});

test('a missing IP assignment blocks assignment', () => {
  const e = assignmentEligibility(signed(['nda', 'non-solicit', 'independent-contractor']));
  assert.equal(e.eligible, false);
  assert.ok(e.missing.some((m) => m.id === 'ip-assignment'));
});

test('a missing NDA blocks assignment', () => {
  const e = assignmentEligibility(signed(['ip-assignment', 'non-solicit', 'independent-contractor']));
  assert.equal(e.eligible, false);
});

test('a missing non-solicit blocks assignment', () => {
  const e = assignmentEligibility(signed(['nda', 'ip-assignment', 'independent-contractor']));
  assert.equal(e.eligible, false);
});

test('a contractor with no agreements at all is blocked, not defaulted through', () => {
  const e = assignmentEligibility({ id: 'dev-x' });
  assert.equal(e.eligible, false);
  assert.equal(e.missing.length, BASE_AGREEMENTS.length);
});

test('an expired agreement blocks assignment', () => {
  const c = signed(BASE_AGREEMENTS);
  c.agreements.nda.expiresAt = '2026-02-01T00:00:00Z';
  const e = assignmentEligibility(c, BASE_AGREEMENTS, { asOf: new Date('2026-09-18T00:00:00Z') });
  assert.equal(e.eligible, false);
  assert.ok(e.expired.some((x) => x.id === 'nda'));
});

test('a suspended contractor is blocked even with clean paperwork', () => {
  assert.equal(assignmentEligibility(signed(BASE_AGREEMENTS, { suspended: true })).eligible, false);
});

test('no payment details means a fixed-price milestone cannot settle', () => {
  assert.equal(assignmentEligibility(signed(BASE_AGREEMENTS, { paymentDetailsOnFile: false })).eligible, false);
});

test('a PHI engagement additionally requires a BAA before assignment', () => {
  const t = ticket('sandbox', ['HIPAA_BAA_REQUIRED']);
  assert.throws(() => assignTicket(t, READY), /baa/i);
  const withBaa = signed([...BASE_AGREEMENTS, 'baa']);
  assert.doesNotThrow(() => assignTicket(t, withBaa));
});

test('a valid assignment records the fixed price, tier and grants', () => {
  const a = assignTicket(ticket('staging'), READY);
  assert.equal(a.fixedPrice, 775);
  assert.equal(a.billing, 'fixed-price-on-acceptance');
  assert.equal(a.accessTier, 'staging');
  assert.ok(a.grants.includes('staging-env'));
  assert.ok(a.denied.includes('production-deploy'));
  assert.ok(a.channelRules.length > 0);
});

test('assignment refuses a ticket with no access plan', () => {
  assert.throws(() => assignTicket({ id: 'raw', fixedPrice: 100 }, READY), /no access plan/);
});

test('assignment refuses an unpapered contractor rather than warning', () => {
  assert.throws(() => assignTicket(ticket(), { id: 'dev-y' }), /Cannot assign/);
});

test('a contractor quoting their own rate is not relayed to the client', () => {
  const r = reviewContractorMessage('My rate for the next phase would be $85/hour');
  assert.equal(r.relay, false);
  assert.ok(r.findings.length >= 1);
});

test('a contractor soliciting a direct relationship is not relayed', () => {
  const r = reviewContractorMessage('You could just hire me directly and skip the agency');
  assert.equal(r.relay, false);
});

test('a contractor offering a direct payment path is not relayed', () => {
  assert.equal(reviewContractorMessage('Send the invoice payment to my PayPal').relay, false);
});

test('a contractor routing the client to their own channel is not relayed', () => {
  assert.equal(reviewContractorMessage('Here is my Calendly if you want to chat').relay, false);
});

test('a purely technical answer relays fine', () => {
  const r = reviewContractorMessage('The webhook retries three times with exponential backoff before dead-lettering.');
  assert.equal(r.relay, true);
  assert.deepEqual(r.findings, []);
});

test('internal messages are not channel-policed', () => {
  const r = reviewContractorMessage('My rate is $85/hour', { clientFacing: false });
  assert.equal(r.relay, true);
});

test('a blocked message tells us to answer the client ourselves', () => {
  assert.match(reviewContractorMessage('I can also build that for $4000').action, /Answer the client directly ourselves/);
});

test('onboarding covers every base agreement plus the channel briefing', () => {
  const list = onboardingChecklist();
  for (const id of BASE_AGREEMENTS) assert.ok(list.some((i) => i.includes(id)), id);
  assert.ok(list.some((i) => /reserved-commercial-acts/.test(i)));
  assert.ok(list.some((i) => /not per hour/.test(i)));
});
