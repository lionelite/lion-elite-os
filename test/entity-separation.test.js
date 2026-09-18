'use strict';

// Legal entity separation.
//
// The tests that matter are the ones proving the boundary cannot be crossed by
// accident: a campaign cannot send as an entity it did not declare, a prospect
// acquired by one entity cannot be mailed by another, consent does not
// transfer, and an entity that does not legally exist yet cannot do anything
// at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ENTITIES,
  assertConsentScope,
  assertEntityShape,
  assertPostureMatch,
  assertProspectEntity,
  assertSendable,
  describeSendability,
  describeSmsSendability,
  getEntity,
  listEntities,
  suppressionKey
} = require('../lib/entities/registry');

const { CAMPAIGNS, assertSafeguards, campaignsForEntity } = require('../lib/outreach/campaigns');
const { SUPPORTED_COMPLIANCE_MODES } = require('../lib/social/social-compliance');
const { resolveSenderAddresses } = require('../lib/email-delivery');

const validEntity = () => ({
  id: 'test_entity',
  legalName: 'Test Entity LLC',
  formationState: 'FL',
  registeredAddress: '1 Test Way',
  status: 'active',
  posture: 'ruo_research_supply',
  brand: 'test',
  complianceMode: 'research-only',
  customerTypes: ['research_buyer'],
  sending: {
    fromEnvVar: 'TEST_FROM_EMAIL',
    postalAddressEnvVar: 'TEST_POSTAL_ADDRESS',
    unsubscribeEnvVar: 'TEST_UNSUBSCRIBE_EMAIL',
    smsFromEnvVar: 'TEST_TWILIO_FROM_NUMBER'
  }
});

test('the registry holds exactly the three entities, and no fourth by accident', () => {
  assert.deepEqual(listEntities().map(entity => entity.id).sort(),
    ['clinic_supply_llc', 'lion_elite_beauty', 'lion_elite_wellness']);
  assert.equal(getEntity('lion_elite_wellness').posture, 'ruo_research_supply');
  assert.equal(getEntity('lion_elite_beauty').posture, 'cosmetics_and_coaching');
  assert.equal(getEntity('clinic_supply_llc').posture, 'api_for_compounding');
  assert.throws(() => getEntity('nope'), /Unknown entity/);
});

test('each posture pins its compliance mode, in both directions', () => {
  assert.throws(
    () => assertEntityShape({ ...validEntity(), posture: 'cosmetics_and_coaching', complianceMode: 'research-only' }),
    /requires complianceMode 'coaching'/
  );
  assert.doesNotThrow(
    () => assertEntityShape({ ...validEntity(), posture: 'cosmetics_and_coaching', complianceMode: 'coaching' })
  );
});

test('entities may not share an SMS origination either', () => {
  // A2P 10DLC brand registration is per legal entity, so a shared number means
  // texting under another entity's carrier registration.
  const numbers = listEntities().map(entity => entity.sending.smsFromEnvVar);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(describeSmsSendability('lion_elite_beauty', {}).sendable, false);
  assert.equal(describeSmsSendability('lion_elite_wellness', { TWILIO_FROM_NUMBER: '+15550000000' }).sendable, true);
});

test('e-mail and SMS sendability are independent', () => {
  // Beauty has no e-mail campaign; that must not block its texts, and a
  // configured number must not imply a configured address.
  assert.equal(describeSendability('lion_elite_beauty', { BEAUTY_TWILIO_FROM_NUMBER: '+1555' }).sendable, false);
  assert.equal(describeSmsSendability('lion_elite_beauty', { BEAUTY_TWILIO_FROM_NUMBER: '+1555' }).sendable, true);
});

test('the clinic-supply entity is inert until it actually exists', () => {
  const outcome = describeSendability('clinic_supply_llc', { CLINIC_SUPPLY_FROM_EMAIL: 'x@example.com' });
  assert.equal(outcome.sendable, false);
  assert.ok(outcome.reasons.some(reason => reason.includes('forming')));
  assert.ok(outcome.reasons.some(reason => reason.includes('legalName')));
  assert.throws(() => assertSendable('clinic_supply_llc', {}), /may not send/);
});

test('the clinic-supply mode now has rules, so only company facts remain outstanding', () => {
  // This blocker was real until the clinical-supply ruleset was written. What
  // is left is not code: it is a company that does not exist yet.
  assert.ok(SUPPORTED_COMPLIANCE_MODES.includes(getEntity('clinic_supply_llc').complianceMode));
  const outcome = describeSendability('clinic_supply_llc', { CLINIC_SUPPLY_FROM_EMAIL: 'x@example.com' });
  assert.ok(!outcome.reasons.some(reason => reason.includes('unknown_compliance_mode')));
  assert.deepEqual(outcome.reasons.filter(reason => !reason.includes('is not recorded')), [
    'entity status is "forming" — only an active entity may send'
  ]);
});

test('the wellness entity sends exactly when its from-address is configured', () => {
  assert.equal(describeSendability('lion_elite_wellness', {}).sendable, false);
  const identity = assertSendable('lion_elite_wellness', { OUTREACH_FROM_EMAIL: 'send@example.com' });
  assert.equal(identity.from, 'send@example.com');
});

test('entities may not share a sending identity', () => {
  const shared = Object.values(ENTITIES).map(entity => entity.sending.fromEnvVar);
  assert.equal(new Set(shared).size, shared.length);
});

test('a malformed entity is refused at registration', () => {
  assert.throws(() => assertEntityShape({ ...validEntity(), posture: 'whatever' }), /posture must be one of/);
  assert.throws(() => assertEntityShape({ ...validEntity(), customerTypes: [] }), /customerTypes/);
  assert.throws(() => assertEntityShape({ ...validEntity(), sending: { fromEnvVar: 'X' } }), /sending\.postalAddressEnvVar/);
});

test('an RUO entity cannot leave research-only compliance', () => {
  assert.throws(
    () => assertEntityShape({ ...validEntity(), complianceMode: 'coaching' }),
    /requires complianceMode 'research-only'/
  );
});

test('an active entity cannot declare a compliance mode with no rules behind it', () => {
  assert.throws(
    () => assertEntityShape({ ...validEntity(), posture: 'api_for_compounding', complianceMode: 'not-a-written-mode' }),
    /has no rules in lib\/social\/social-compliance\.js/
  );
  // The same declaration is allowed while forming — that is how the gap is recorded.
  assert.doesNotThrow(
    () => assertEntityShape({ ...validEntity(), status: 'forming', posture: 'api_for_compounding', complianceMode: 'not-a-written-mode' })
  );
  // And a mode that HAS been written is fine on an active entity.
  assert.doesNotThrow(
    () => assertEntityShape({ ...validEntity(), posture: 'api_for_compounding', complianceMode: 'clinical-supply' })
  );
});

test('every registered campaign sends as a real entity, in that entity\'s mode', () => {
  for (const campaign of Object.values(CAMPAIGNS)) {
    const entity = getEntity(campaign.entityId);
    assert.equal(campaign.complianceMode, entity.complianceMode, `${campaign.id} mode must match ${entity.id}`);
  }
  assert.deepEqual(
    campaignsForEntity('lion_elite_wellness').map(campaign => campaign.id).sort(),
    ['client_research_reorder', 'gated_lead_welcome', 'med_spa_research_supply']
  );
  assert.deepEqual(campaignsForEntity('clinic_supply_llc'), []);
});

test('a campaign cannot be registered without an entity, or in a mode that is not its entity\'s', () => {
  const base = {
    id: 'rogue',
    audienceType: 'business',
    complianceMode: 'research-only',
    safeguards: { complianceValidation: true, suppressionCheck: true, dailyQuota: true, killSwitch: true }
  };
  assert.throws(() => assertSafeguards(base), /must declare the entityId/);
  assert.throws(
    () => assertSafeguards({ ...base, entityId: 'lion_elite_wellness', complianceMode: 'coaching' }),
    /must use research-only compliance mode/
  );
});

test('a prospect may only be mailed by the entity that acquired it', () => {
  const campaign = CAMPAIGNS.med_spa_research_supply;
  assert.ok(assertProspectEntity({ entityId: 'lion_elite_wellness' }, campaign));
  assert.ok(assertProspectEntity({ entity_id: 'lion_elite_wellness' }, campaign), 'accepts the raw database column');

  assert.throws(
    () => assertProspectEntity({ entityId: 'clinic_supply_llc' }, campaign),
    error => error.code === 'ENTITY_MISMATCH'
  );
  assert.throws(
    () => assertProspectEntity({}, campaign),
    error => error.code === 'PROSPECT_ENTITY_MISSING'
  );
});

test('consent does not transfer between entities', () => {
  assert.ok(assertConsentScope({ entityId: 'lion_elite_wellness' }, 'lion_elite_wellness'));
  assert.throws(
    () => assertConsentScope({ entityId: 'lion_elite_wellness' }, 'clinic_supply_llc'),
    error => error.code === 'CONSENT_ENTITY_MISMATCH'
  );
  assert.throws(() => assertConsentScope({}, 'lion_elite_wellness'), /none recorded/);
});

test('suppression keys are namespaced per entity', () => {
  assert.equal(suppressionKey('lion_elite_wellness', 'A@Example.com '), 'suppression:lion_elite_wellness:a@example.com');
  assert.notEqual(
    suppressionKey('lion_elite_wellness', 'a@example.com'),
    suppressionKey('clinic_supply_llc', 'a@example.com')
  );
  assert.throws(() => suppressionKey('nope', 'a@example.com'), /Unknown entity/);
});

test('posture and activation are both enforced on a release record holder', () => {
  assert.ok(assertPostureMatch('lion_elite_wellness', 'ruo_research_supply'));
  assert.throws(
    () => assertPostureMatch('lion_elite_wellness', 'api_for_compounding'),
    error => error.code === 'POSTURE_MISMATCH'
  );
  assert.throws(
    () => assertPostureMatch('clinic_supply_llc', 'api_for_compounding'),
    error => error.code === 'ENTITY_NOT_ACTIVE'
  );
});

// CI provisions Redis but not Postgres, so schema/code drift is caught by
// reading the source rather than by a live query — same approach as
// test/postgres-prospect-store-schema.test.js, and for the same reason.
test('entity_id exists in the schema and is written by both insert paths', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const store = fs.readFileSync(path.join(__dirname, '..', 'lib', 'postgres-prospect-store.js'), 'utf8');

  for (const table of ['prospects', 'outreach_queue']) {
    assert.match(schema, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entity_id`),
      `${table} must carry entity_id`);
  }

  const prospectInsert = store.slice(store.indexOf('INSERT INTO prospects'), store.indexOf('RETURNING *'));
  assert.ok(prospectInsert.includes('entity_id'), 'the prospect insert must write entity_id');

  const queueInsertStart = store.indexOf('INSERT INTO outreach_queue');
  const queueInsert = store.slice(queueInsertStart, store.indexOf('RETURNING *', queueInsertStart));
  assert.ok(queueInsert.includes('entity_id'), 'the queue insert must write entity_id');
  assert.ok(store.includes('prospect.entity_id'),
    'the queue insert must take the entity from the stored prospect, not the caller');
});

// --- send path -------------------------------------------------------------

test('with no identity the sender addresses are read from the environment, unchanged', () => {
  const env = process.env;
  const saved = { ...env };
  try {
    env.OUTREACH_FROM_EMAIL = 'from@wellness.test';
    env.OUTREACH_REPLY_TO = 'reply@wellness.test';
    env.OUTREACH_UNSUBSCRIBE_EMAIL = 'unsub@wellness.test';
    env.OUTREACH_POSTAL_ADDRESS = '1 Wellness Way';
    assert.deepEqual(resolveSenderAddresses(), {
      from: 'from@wellness.test',
      replyTo: 'reply@wellness.test',
      unsubscribe: 'unsub@wellness.test',
      postalAddress: '1 Wellness Way'
    });
  } finally {
    for (const key of ['OUTREACH_FROM_EMAIL', 'OUTREACH_REPLY_TO', 'OUTREACH_UNSUBSCRIBE_EMAIL', 'OUTREACH_POSTAL_ADDRESS']) {
      if (saved[key] === undefined) delete env[key]; else env[key] = saved[key];
    }
  }
});

test('a second entity never falls back to the first entity\'s addresses', () => {
  const saved = process.env.OUTREACH_FROM_EMAIL;
  try {
    process.env.OUTREACH_FROM_EMAIL = 'from@wellness.test';
    process.env.OUTREACH_REPLY_TO = 'reply@wellness.test';
    // Only `from` is configured for the second entity: reply-to and unsubscribe
    // must fall back to ITS from-address, never to the environment's.
    const sender = resolveSenderAddresses({ from: 'from@clinic.test' });
    assert.equal(sender.from, 'from@clinic.test');
    assert.equal(sender.replyTo, 'from@clinic.test');
    assert.equal(sender.unsubscribe, 'from@clinic.test');
    assert.equal(sender.postalAddress, undefined);
    for (const value of Object.values(sender)) {
      assert.ok(!String(value).includes('wellness.test'), `leaked a wellness address: ${value}`);
    }
  } finally {
    if (saved === undefined) delete process.env.OUTREACH_FROM_EMAIL; else process.env.OUTREACH_FROM_EMAIL = saved;
    delete process.env.OUTREACH_REPLY_TO;
  }
});

// The worker starts BullMQ consumers on require, so its wiring is pinned by
// reading the source — the same approach test/outreach-automation.test.js uses
// for the queue, quota and kill-switch invariants.
test('the outreach worker enforces the entity boundary on both send paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'workers', 'outreach-worker.js'), 'utf8');

  assert.match(source, /assertProspectEntity\(/, 'validation must check the prospect against its campaign');
  assert.match(source, /assertSendable\(entityId\)/, 'dispatch must resolve a sendable entity');
  assert.match(source, /sendEmail\(\{[^}]*identity \}\)/,
    'the send must carry the resolved identity, not the ambient environment');

  const dispatch = source.slice(source.indexOf('QUEUE_NAMES.dispatch'));
  const halt = dispatch.indexOf('isHalted');
  const entity = dispatch.indexOf('assertSendable');
  const processing = dispatch.indexOf("'processing'");
  const send = dispatch.indexOf('sendEmail(');

  assert.ok(halt < entity, 'the kill switch must win over the entity check');
  assert.ok(entity < processing,
    'an unsendable entity must fail before the row is marked processing, so the item stays resumable');
  assert.ok(processing < send);
});
