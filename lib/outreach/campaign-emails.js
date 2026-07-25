'use strict';

// Email builders for the med-spa research-supply (B2B) and client research
// reorder (B2C) campaigns. Both are deliberately written in RESEARCH-USE-ONLY
// language and then RUN THROUGH the fail-closed compliance validator before
// they are returned. If a build ever drifts into human-use / dosing /
// transformation language, `approved` comes back false with blockers and the
// caller must not send it — the copy cannot silently become a human-use pitch.

const { validateContent, RESEARCH_DISCLAIMER_PHRASE } = require('../social/social-compliance');

const WELLNESS_SIGNATURE = Object.freeze({
  name: 'Alexander Ringfield',
  brand: 'Lion Elite Wellness',
  website: 'https://lionelitewellness.com'
});

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

// Attach compliance to any built draft; single choke point.
function withCompliance(draft) {
  const compliance = validateContent({ text: draft.body, complianceMode: 'research-only', requireDisclaimer: true });
  return { ...draft, compliance, approved: compliance.approved };
}

/**
 * B2B: research-grade peptide SUPPLY introduction to a med spa / clinic.
 * RUO framing only — positions Lion Elite Wellness as a documented research
 * supplier, never a treatment/administration partner.
 */
function buildResearchSupplyEmail(input = {}) {
  const businessName = clean(input.businessName);
  if (!businessName) throw new Error('businessName is required.');
  const contactName = clean(input.contactName);
  const greeting = contactName ? `Hi ${contactName},` : `Hi ${businessName} team,`;
  const signature = { ...WELLNESS_SIGNATURE, ...(input.signature || {}) };

  const body = [
    greeting,
    `I'm reaching out from ${signature.brand}. We supply research-grade peptides for ${RESEARCH_DISCLAIMER_PHRASE}, with batch-specific third-party testing, a certificate of analysis for every batch, and clear research-use-only labeling on each item.`,
    `If ${businessName} sources research compounds, we'd like to be considered as a supplier. What distinguishes our catalog is verifiable documentation and consistent, reliable fulfillment.`,
    'Would you be open to a short call to review our research catalog and the batch testing documentation?',
    `Best,\n${signature.name}\n${signature.brand}\n${signature.website}`
  ].join('\n\n');

  return withCompliance({
    campaignId: 'med_spa_research_supply',
    subject: `Research-grade supply documentation for ${businessName}`,
    body,
    signature
  });
}

/**
 * B2C: reorder reminder to an EXISTING research customer. RUO framing plus the
 * CAN-SPAM essentials — a working unsubscribe line and a physical postal
 * address are REQUIRED (throws if absent), because this is a consumer send.
 */
function buildReorderEmail(input = {}) {
  const firstName = clean(input.firstName || input.contactName);
  const reorderUrl = clean(input.reorderUrl);
  const unsubscribeUrl = clean(input.unsubscribeUrl || input.unsubscribeEmail);
  const postalAddress = clean(input.postalAddress);
  if (!unsubscribeUrl) throw new Error('unsubscribe link/email is required for a consumer send (CAN-SPAM).');
  if (!postalAddress) throw new Error('postal address is required for a consumer send (CAN-SPAM).');

  const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
  const signature = { ...WELLNESS_SIGNATURE, ...(input.signature || {}) };
  const reorderLine = reorderUrl
    ? `You can reorder here anytime: ${reorderUrl}.`
    : 'You can reorder anytime from your account.';

  const body = [
    greeting,
    `Thank you for being a ${signature.brand} research customer. This is a reminder that the research-grade items you previously purchased are available to reorder for ${RESEARCH_DISCLAIMER_PHRASE}.`,
    'Every item ships with batch-specific third-party testing and research-use-only labeling.',
    reorderLine,
    `Best,\n${signature.name}\n${signature.brand}\n${signature.website}`,
    `If you'd prefer not to receive these reminders, unsubscribe here: ${unsubscribeUrl}`,
    postalAddress
  ].join('\n\n');

  return withCompliance({
    campaignId: 'client_research_reorder',
    subject: 'Reorder your Lion Elite research supply',
    body,
    signature,
    canSpam: { unsubscribe: unsubscribeUrl, postalAddress }
  });
}

const BUILDERS = Object.freeze({ researchSupply: buildResearchSupplyEmail, reorder: buildReorderEmail });

module.exports = {
  WELLNESS_SIGNATURE,
  buildResearchSupplyEmail,
  buildReorderEmail,
  BUILDERS
};
