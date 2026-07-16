'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendSms, getConfig, normalizePhone, validateMessage } = require('../lib/twilio-delivery');

const enabledEnv = {
  SMS_SEND_ENABLED: 'true',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'test-token',
  TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000'
};

test('Twilio delivery is fail-closed until explicitly enabled and configured', () => {
  assert.throws(() => getConfig({}), error => error.code === 'SMS_SEND_DISABLED');
  assert.throws(() => getConfig({ SMS_SEND_ENABLED: 'true' }), error => error.code === 'TWILIO_CONFIGURATION_ERROR');
});

test('normalizes only valid E.164 recipients', () => {
  assert.equal(normalizePhone('+13055551234'), '+13055551234');
  assert.throws(() => normalizePhone('305-555-1234'), error => error.code === 'INVALID_SMS_RECIPIENT');
});

test('blocks unauthorized, suppressed, empty, and oversized messages', () => {
  const base = { prospect: { contact: { phone: '+13055551234' } }, draft: { body: 'Hello' }, authorization: { authorized: true } };
  assert.throws(() => validateMessage({ ...base, authorization: { authorized: false } }), error => error.code === 'SMS_NOT_AUTHORIZED');
  assert.throws(() => validateMessage({ ...base, prospect: { ...base.prospect, status: 'suppressed' } }), error => error.code === 'SMS_RECIPIENT_SUPPRESSED');
  assert.throws(() => validateMessage({ ...base, draft: { body: '' } }), error => error.code === 'SMS_BODY_REQUIRED');
  assert.throws(() => validateMessage({ ...base, draft: { body: 'x'.repeat(1601) } }), error => error.code === 'SMS_BODY_TOO_LONG');
});

test('sends through a Twilio Messaging Service and returns provider metadata', async () => {
  let request;
  const client = {
    messages: {
      create: async payload => {
        request = payload;
        return { sid: 'SM123', status: 'queued' };
      }
    }
  };

  const result = await sendSms({
    prospect: { contact: { phone: '+13055551234' } },
    draft: { body: 'What is your biggest fitness goal right now?' },
    authorization: { authorized: true }
  }, { env: enabledEnv, client });

  assert.equal(request.to, '+13055551234');
  assert.equal(request.messagingServiceSid, enabledEnv.TWILIO_MESSAGING_SERVICE_SID);
  assert.equal(result.provider, 'twilio');
  assert.equal(result.providerId, 'SM123');
});
