'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareBulkOutreach } = require('../lib/bulk-outreach');

function eligibleProspect(id, email) {
  return {
    prospectId: id,
    business: { name: 'Example Gym', domain: 'example.com' },
    contact: { email },
    source: { approved: true, url: 'https://example.com/signup' },
    identityStatus: 'verified', identityConfidence: 1,
    duplicateStatus: 'clear', campaignEligibility: 'eligible', state: 'qualified',
    suppressionStatus: 'clear', optOut: false, lastVerifiedAt: new Date().toISOString(),
    qualificationScore: { percentage: 100 }, personalization: { qualityScore: 100, evidenceCoverage: 1 },
    crmSyncStatus: 'synced', cadenceStatus: 'allowed', complianceStatus: 'passed',
    contactCountInWindow: 0, messageVersionStatus: 'approved'
  };
}

const policy = { approvedChannels: ['email'], requiredBusinessFields: ['name','domain'] };

test('prepares eligible unique recipients for bulk outreach', () => {
  const result = prepareBulkOutreach([
    { prospect: eligibleProspect('p1', 'one@example.com'), message: { recipient: 'ONE@example.com', subject: 'Hello', body: 'Message' } },
    { prospect: eligibleProspect('p2', 'two@example.com'), message: { recipient: 'two@example.com', subject: 'Hello', body: 'Message' } }
  ], policy, { remaining: 100 });
  assert.equal(result.length, 2);
  assert.equal(result[0].message.recipient, 'one@example.com');
  assert.equal(result[0].authorization.authorized, true);
});

test('rejects recipient mismatches, duplicates, ineligible prospects, and quota overflow', () => {
  assert.throws(() => prepareBulkOutreach([{ prospect: eligibleProspect('p1', 'one@example.com'), message: { recipient: 'other@example.com' } }], policy, { remaining: 100 }), /verified email/);
  assert.throws(() => prepareBulkOutreach([
    { prospect: eligibleProspect('p1', 'one@example.com'), message: { recipient: 'one@example.com' } },
    { prospect: eligibleProspect('p2', 'one@example.com'), message: { recipient: 'one@example.com' } }
  ], policy, { remaining: 100 }), /Duplicate/);
  const blocked = eligibleProspect('p1', 'one@example.com'); blocked.optOut = true;
  assert.throws(() => prepareBulkOutreach([{ prospect: blocked, message: { recipient: 'one@example.com' } }], policy, { remaining: 100 }), /Outreach blocked/);
  assert.throws(() => prepareBulkOutreach([{ prospect: eligibleProspect('p1', 'one@example.com'), message: { recipient: 'one@example.com' } }], policy, { remaining: 0 }), /0 email slots/);
});
