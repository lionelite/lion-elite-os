const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, resolveCapabilities, scopeGuard, capability, vertical, TARGET_VERTICALS } = require('../src/offer');

test('required capabilities are always included even when not requested', () => {
  const resolved = resolveCapabilities(['scheduling']);
  const ids = resolved.map((c) => c.id);
  for (const required of CAPABILITIES.filter((c) => c.required)) {
    assert.ok(ids.includes(required.id), `${required.id} must be present`);
  }
  assert.ok(ids.includes('scheduling'));
});

test('capabilities come back in canonical delivery order, not request order', () => {
  const ids = resolveCapabilities(['reporting', 'lead-capture']).map((c) => c.id);
  assert.deepEqual(ids, CAPABILITIES.map((c) => c.id).filter((id) => ids.includes(id)));
  assert.ok(ids.indexOf('lead-capture') < ids.indexOf('reporting'));
});

test('an unknown capability is rejected rather than silently dropped', () => {
  assert.throws(() => resolveCapabilities(['lead-capture', 'build-me-a-crm']), /Unknown capability/);
});

test('every capability carries an outcome and a verification statement', () => {
  for (const cap of CAPABILITIES) {
    assert.ok(cap.outcome && cap.outcome.length > 10, `${cap.id} needs an outcome`);
    assert.ok(cap.verification && cap.verification.length > 10, `${cap.id} needs a verification statement`);
  }
});

test('scope guard declines out-of-offer work with a stated reason', () => {
  const result = scopeGuard('We also need a mobile app for our field crews');
  assert.equal(result.inScope, false);
  assert.equal(result.declines.length, 1);
  assert.match(result.declines[0].reason, /mobile app/i);
});

test('scope guard declines hourly staff augmentation — it inverts the margin model', () => {
  const result = scopeGuard('Can we just get a dedicated developer for a few months?');
  assert.equal(result.inScope, false);
  assert.match(result.declines[0].reason, /Staff augmentation/i);
});

test('scope guard declines a guaranteed-revenue request', () => {
  assert.equal(scopeGuard('We need guaranteed revenue from this').inScope, false);
});

test('scope guard passes a normal in-offer request', () => {
  const result = scopeGuard('We miss calls after hours and nobody follows up on web form leads');
  assert.equal(result.inScope, true);
  assert.deepEqual(result.declines, []);
});

test('scope guard surfaces a priced add-on instead of absorbing it', () => {
  const result = scopeGuard('We would need our CRM migration handled too');
  assert.equal(result.inScope, true);
  assert.ok(result.addOns.some((a) => a.id === 'crm-migration'));
});

test('regulated verticals carry compliance flags', () => {
  assert.ok(vertical('private-medical').complianceFlags.includes('PHI'));
  assert.ok(vertical('financial-services').complianceFlags.includes('PII_FINANCIAL'));
  assert.deepEqual(vertical('specialty-contractor').complianceFlags, []);
});

test('every target vertical has a customer value in the thousands', () => {
  for (const v of TARGET_VERTICALS) {
    assert.ok(v.minCustomerValue >= 1000, `${v.id} must clear the thousand-dollar bar`);
  }
});

test('unknown ids look up to null rather than throwing', () => {
  assert.equal(capability('nope'), null);
  assert.equal(vertical('nope'), null);
});
