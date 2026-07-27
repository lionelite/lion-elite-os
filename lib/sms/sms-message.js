'use strict';

// SMS message builders. Every text is RESEARCH-USE-ONLY, brand-identified, and
// carries a mandatory STOP opt-out (TCPA), then run through the same fail-closed
// compliance validator the rest of the system uses. If a message drifts into
// human-use / dosing / transformation language it comes back approved:false and
// must not send.

const { validateContent, RESEARCH_DISCLAIMER_PHRASE } = require('../social/social-compliance');

const BRAND = 'Lion Elite Wellness';
const OPT_OUT = 'Reply STOP to opt out.';
const SEGMENT = 160; // GSM-7 single-segment length; longer = multi-segment (still valid)

function clean(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

// Segments a message would use — surfaced so we keep texts short/cheap.
function segments(text) {
  return Math.max(1, Math.ceil(clean(text).length / SEGMENT));
}

function withCompliance(body) {
  const compliance = validateContent({ text: body, complianceMode: 'research-only', requireDisclaimer: true });
  return { body, compliance, approved: compliance.approved, length: clean(body).length, segments: segments(body) };
}

/**
 * B2C reorder text to an EXISTING, CONSENTED research customer.
 * Must include: brand ID, RUO framing, the research disclaimer, and STOP.
 */
function buildReorderSms({ firstName, reorderUrl } = {}) {
  const name = clean(firstName);
  const hi = name ? `${name}, ` : '';
  const link = clean(reorderUrl);
  const linkPart = link ? ` Reorder: ${link}` : '';
  // Kept deliberately plain — RUO, no benefit/human-use language.
  const body = `${BRAND}: ${hi}your previously purchased research-grade items are available to reorder for ${RESEARCH_DISCLAIMER_PHRASE}.${linkPart} ${OPT_OUT}`;
  return withCompliance(body);
}

const BUILDERS = Object.freeze({ reorder: buildReorderSms });

module.exports = { BRAND, OPT_OUT, SEGMENT, segments, buildReorderSms, BUILDERS };
