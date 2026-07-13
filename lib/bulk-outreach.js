'use strict';

const { authorizeOutreach } = require('./outreach-validation');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function prepareBulkOutreach(items, policy, quota) {
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('At least one prospect is required.'), { code: 'EMPTY_BULK_REQUEST' });
  }
  const maximum = Math.min(100, Number(quota?.remaining || 0));
  if (items.length > maximum) {
    throw Object.assign(new Error(`Only ${maximum} email slots remain today.`), { code: 'BULK_DAILY_LIMIT_EXCEEDED' });
  }
  const seen = new Set();
  return items.map((item, index) => {
    const prospect = item?.prospect;
    const message = item?.message || {};
    if (!prospect?.prospectId) throw Object.assign(new Error(`Item ${index + 1} is missing prospectId.`), { code: 'BULK_PROSPECT_REQUIRED' });
    const recipient = normalizeEmail(message.recipient);
    const verifiedEmail = normalizeEmail(prospect?.contact?.email);
    if (!recipient || recipient !== verifiedEmail) {
      throw Object.assign(new Error(`Item ${index + 1} recipient must match the prospect's verified email.`), { code: 'BULK_RECIPIENT_MISMATCH' });
    }
    if (seen.has(recipient)) throw Object.assign(new Error(`Duplicate bulk recipient: ${recipient}`), { code: 'BULK_DUPLICATE_RECIPIENT' });
    seen.add(recipient);
    const authorization = authorizeOutreach({ ...prospect, id: prospect.prospectId, channel: 'email' }, policy);
    return { prospectId: prospect.prospectId, prospect, message: { ...message, recipient }, authorization };
  });
}

module.exports = { prepareBulkOutreach, normalizeEmail };
