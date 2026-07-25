'use strict';

const twilio = require('twilio');

function required(name, env = process.env) {
  const value = String(env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is required.`);
    error.code = 'TWILIO_CONFIGURATION_ERROR';
    throw error;
  }
  return value;
}

function normalizePhone(value) {
  const phone = String(value || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    const error = new Error('SMS recipient must be a valid E.164 phone number.');
    error.code = 'INVALID_SMS_RECIPIENT';
    throw error;
  }
  return phone;
}

function getConfig(env = process.env) {
  if (String(env.SMS_SEND_ENABLED).toLowerCase() !== 'true') {
    const error = new Error('SMS delivery is disabled.');
    error.code = 'SMS_SEND_DISABLED';
    throw error;
  }

  const messagingServiceSid = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim() || undefined;
  const fromNumber = String(env.TWILIO_FROM_NUMBER || '').trim()
    ? normalizePhone(env.TWILIO_FROM_NUMBER)
    : undefined;

  if (!messagingServiceSid && !fromNumber) {
    const error = new Error('TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER is required.');
    error.code = 'TWILIO_CONFIGURATION_ERROR';
    throw error;
  }

  return {
    accountSid: required('TWILIO_ACCOUNT_SID', env),
    authToken: required('TWILIO_AUTH_TOKEN', env),
    messagingServiceSid,
    fromNumber,
    statusCallback: String(env.TWILIO_STATUS_CALLBACK_URL || '').trim() || undefined
  };
}

function validateMessage({ prospect, draft, authorization }) {
  if (!authorization?.authorized) {
    const error = new Error('SMS delivery requires a valid outreach authorization.');
    error.code = 'SMS_NOT_AUTHORIZED';
    throw error;
  }
  if (prospect?.status === 'suppressed' || prospect?.optOut === true) {
    const error = new Error('Suppressed or opted-out prospects cannot receive SMS.');
    error.code = 'SMS_RECIPIENT_SUPPRESSED';
    throw error;
  }

  const to = normalizePhone(draft?.recipient || prospect?.contact?.phone);
  const body = String(draft?.body || '').trim();
  if (!body) {
    const error = new Error('SMS body is required.');
    error.code = 'SMS_BODY_REQUIRED';
    throw error;
  }
  if (body.length > 1600) {
    const error = new Error('SMS body exceeds Twilio maximum length.');
    error.code = 'SMS_BODY_TOO_LONG';
    throw error;
  }

  return { to, body };
}

async function sendSms(payload, options = {}) {
  const config = getConfig(options.env || process.env);
  const message = validateMessage(payload);
  const client = options.client || twilio(config.accountSid, config.authToken);

  const result = await client.messages.create({
    to: message.to,
    body: message.body,
    ...(config.messagingServiceSid
      ? { messagingServiceSid: config.messagingServiceSid }
      : { from: config.fromNumber }),
    ...(config.statusCallback ? { statusCallback: config.statusCallback } : {})
  });

  return {
    provider: 'twilio',
    providerId: result.sid,
    status: result.status || 'queued',
    recipient: message.to
  };
}

module.exports = { sendSms, getConfig, normalizePhone, validateMessage };
