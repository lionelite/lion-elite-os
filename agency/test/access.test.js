const test = require('node:test');
const assert = require('node:assert/strict');
const { accessPlanForTicket, reviewAccessRequest, NEVER_GRANT, TIERS, revocationChecklist } = require('../src/access');

const TICKET = { id: 'acme-follow-up-sequence-engine', accessTier: 'sandbox' };

test('a sandbox ticket grants build access and nothing more', () => {
  const plan = accessPlanForTicket(TICKET);
  assert.ok(plan.grants.includes('repo-branch'));
  assert.ok(plan.grants.includes('synthetic-dataset'));
  assert.ok(!plan.grants.includes('staging-env'));
  assert.ok(!plan.grants.includes('production-deploy'));
});

test('base agreements are required on every ticket', () => {
  const plan = accessPlanForTicket(TICKET);
  for (const id of ['nda', 'ip-assignment', 'non-solicit']) assert.ok(plan.requiredAgreements.includes(id));
});

test('PHI downgrades a staging ticket to synthetic fixtures only', () => {
  const plan = accessPlanForTicket({ id: 't', accessTier: 'staging' }, ['PHI']);
  assert.equal(plan.effectiveTier, 'sandbox');
  assert.equal(plan.downgraded, true);
  assert.ok(!plan.grants.includes('staging-env'));
  assert.ok(plan.restrictions.some((r) => /protected health information/i.test(r)));
});

test('a HIPAA engagement requires a BAA before any assignment', () => {
  const plan = accessPlanForTicket(TICKET, ['HIPAA_BAA_REQUIRED']);
  assert.ok(plan.requiredAgreements.includes('baa'));
});

test('financial PII also restricts to synthetic fixtures', () => {
  const plan = accessPlanForTicket({ id: 't', accessTier: 'integration-sandbox' }, ['PII_FINANCIAL']);
  assert.equal(plan.effectiveTier, 'sandbox');
});

test('a compliance cap that is already satisfied still records the constraint', () => {
  const plan = accessPlanForTicket({ id: 't', accessTier: 'sandbox' }, ['PHI']);
  assert.equal(plan.effectiveTier, 'sandbox');
  assert.equal(plan.downgraded, false);
  assert.ok(plan.restrictions.length > 0, 'the constraint belongs on the record either way');
});

test('an unknown tier is rejected', () => {
  assert.throws(() => accessPlanForTicket({ id: 't', accessTier: 'root' }), /Unknown access tier/);
});

test('tiers are ordered from least to most access', () => {
  assert.deepEqual(TIERS, ['docs-only', 'sandbox', 'staging', 'integration-sandbox']);
});

test('every never-granted resource is denied with a reason, whatever the tier', () => {
  for (const resource of Object.keys(NEVER_GRANT)) {
    for (const tier of TIERS) {
      const result = reviewAccessRequest({ resource, ticket: { id: 't', accessTier: tier } });
      assert.equal(result.decision, 'DENY', `${resource} at ${tier}`);
      assert.ok(result.reason.length > 10);
    }
  }
});

test('production credentials are denied with a workable alternative offered', () => {
  const result = reviewAccessRequest({ resource: 'client-production-credentials', ticket: TICKET });
  assert.equal(result.decision, 'DENY');
  assert.match(result.alternative, /we will run it/i);
});

test('direct client contact is denied — it is the commercial channel', () => {
  const result = reviewAccessRequest({ resource: 'client-direct-contact', ticket: TICKET });
  assert.equal(result.decision, 'DENY');
  assert.match(result.reason, /quote the next phase|client communication/i);
});

test('merging to main is never a contractor right', () => {
  assert.equal(reviewAccessRequest({ resource: 'repo-main-branch-write', ticket: TICKET }).decision, 'DENY');
});

test('a resource inside the ticket tier is allowed', () => {
  const result = reviewAccessRequest({ resource: 'repo-branch', ticket: TICKET });
  assert.equal(result.decision, 'ALLOW');
});

test('an unrecognised resource defaults to deny', () => {
  const result = reviewAccessRequest({ resource: 'some-tool-nobody-assessed', ticket: TICKET });
  assert.equal(result.decision, 'DENY');
  assert.match(result.reason, /per-ticket, not per-person/);
});

test('staging access on one ticket does not grant it on another', () => {
  assert.equal(reviewAccessRequest({ resource: 'staging-env', ticket: { id: 'a', accessTier: 'staging' } }).decision, 'ALLOW');
  assert.equal(reviewAccessRequest({ resource: 'staging-env', ticket: { id: 'b', accessTier: 'sandbox' } }).decision, 'DENY');
});

test('an empty request is denied rather than defaulting to anything', () => {
  assert.equal(reviewAccessRequest({ resource: '', ticket: TICKET }).decision, 'DENY');
  assert.equal(reviewAccessRequest({}).decision, 'DENY');
});

test('revocation covers credentials and repo membership', () => {
  const list = revocationChecklist(accessPlanForTicket({ id: 't', accessTier: 'staging' }));
  assert.ok(list.some((i) => /Rotate any staging credential/.test(i)));
  assert.ok(list.some((i) => /repository collaborators/.test(i)));
  assert.ok(list.some((i) => /IP assignment/.test(i)));
});
