'use strict';

/**
 * One follow-up for clinics already contacted (the October sends, recorded on
 * the prospect as stage `contacted`). Not the old pitch again: a short value
 * offer, the "supplier comparison" angle from docs/clinical-decision-maker-pilot.md
 * — send one product spec, get a side-by-side comparison back, keep the
 * benchmark either way.
 *
 * Rules carried over from lib/outreach/clinic-supply-email.js, for the same
 * reasons: no reference to patient services, no savings claim, no guessed
 * names, RUO disclaimer present, opt-out line present, and the whole draft is
 * run through the fail-closed compliance validator.
 *
 * Length: the message (greeting through the question, not the signature or the
 * opt-out line) is 60–90 words. Pinned by test so an edit cannot drift.
 *
 * Version id is a hash of this builder, so it is unapproved until the owner adds
 * it to OUTREACH_APPROVED_MESSAGE_VERSIONS. `npm run outreach:versions` prints it.
 */

const crypto = require('crypto');
const { RESEARCH_DISCLAIMER_PHRASE } = require('../social/social-compliance');
const { WELLNESS_SIGNATURE } = require('./campaign-emails');
const { CAMPAIGN_ID, segmentFor, scoreClinicEmail } = require('./clinic-supply-email');
const { validateContent } = require('../social/social-compliance');

const FOLLOWUP_STEP_ID = 'followup1';

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

function messageParagraphs({ businessName, greeting }) {
  return [
    greeting,
    `A quick follow-up to my earlier note, with something more useful than another pitch.`,
    `Send me the specifications and quantity for one research-grade product ${businessName} buys today, and I'll return a side-by-side supplier comparison: price, lot-matched COA, independent testing and delivery time against your current source. You keep the benchmark either way. Everything we supply is labeled for ${RESEARCH_DISCLAIMER_PHRASE}.`,
    `Would a comparison on one product be useful?`,
  ];
}

function buildClinicFollowUpEmail(input = {}) {
  const businessName = clean(input.businessName);
  if (!businessName) throw new Error('businessName is required.');
  const contactName = clean(input.contactName);
  const greeting = contactName ? `Hi ${contactName},` : `Hi ${businessName} team,`;
  const signature = { ...WELLNESS_SIGNATURE, ...(input.signature || {}) };
  const segment = segmentFor(input);

  const message = messageParagraphs({ businessName, greeting });
  const body = [
    ...message,
    `Best,\n${signature.name}\n${signature.brand}\n${signature.website}`,
    `If this isn't relevant to ${businessName}, reply "no thanks" and I won't contact you again.`,
  ].join('\n\n');

  const draft = {
    campaignId: CAMPAIGN_ID,
    step: FOLLOWUP_STEP_ID,
    messageVersion: followUpVersion(),
    subject: `${businessName}: a quick supplier comparison`,
    body,
    messageWordCount: wordCount(message.join(' ')),
    signature,
    personalization: { businessName, contactName: contactName || null, segment: segment.id, city: null },
  };
  const compliance = validateContent({ text: draft.body, complianceMode: 'research-only', requireDisclaimer: true });
  return { ...draft, compliance, approved: compliance.approved, quality: scoreClinicEmail(draft, compliance.blockers.map(b => b.code)) };
}

function wordCount(text) {
  return clean(text).split(' ').filter(Boolean).length;
}

function followUpVersion() {
  const source = [messageParagraphs.toString(), buildClinicFollowUpEmail.toString(), RESEARCH_DISCLAIMER_PHRASE].join('\n');
  return `clinic-supply-followup-v1-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 8)}`;
}

module.exports = { FOLLOWUP_STEP_ID, buildClinicFollowUpEmail, followUpVersion, wordCount };
