'use strict';

// Governed "reach out to all" selection. Pure, testable logic for picking
// which stored prospects are eligible to enter the outreach pipeline.
//
// This does NOT send and does NOT bypass any safeguard. Selected prospects
// are fed into the existing email → validation → dispatch chain, where each
// one is still individually validated (16-check), suppression-checked, and
// dispatched only under the transactional daily quota + Redis kill switch.
// "Reach out to all" therefore means "enqueue every eligible prospect and
// let the worker send them at the governed daily pace" — never a blast.

// Stages that mean "already contacted / terminal / in-flight" — never
// re-enqueue these.
const EXCLUDED_STAGES = new Set([
  'queued', 'sent', 'engaged', 'meeting_booked', 'opportunity',
  'customer', 'disqualified', 'suppressed'
]);

function hasEmail(prospect) {
  const email = prospect && prospect.contact && prospect.contact.email;
  return typeof email === 'string' && email.includes('@');
}

/**
 * Filter a list of prospect records down to outreach-eligible ones.
 * Reasons for exclusion are returned alongside so a dry run can explain
 * itself. Never mutates input.
 */
function selectOutreachCandidates(prospects = [], { excludeStages = EXCLUDED_STAGES } = {}) {
  const eligible = [];
  const skipped = [];
  for (const prospect of prospects) {
    let reason = null;
    if (prospect.status === 'suppressed') reason = 'suppressed';
    else if (!hasEmail(prospect)) reason = 'no_email';
    else if (excludeStages.has(prospect.stage)) reason = `stage_${prospect.stage}`;

    if (reason) skipped.push({ prospectId: prospect.prospectId, reason });
    else eligible.push(prospect);
  }
  // Highest-scoring first so a capped run reaches out to the best leads.
  eligible.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return { eligible, skipped };
}

/**
 * Build the email-queue job context for one prospect from its stored
 * record, mapping to the fields lib/email-generation.buildEmail expects.
 * The full prospect + an empty policy ride along for the validation and
 * dispatch stages.
 */
function buildEmailJobContext(prospect) {
  const business = prospect.business || {};
  const personalization = prospect.personalization || {};
  return {
    prospect,
    policy: {},
    businessName: business.name || business.displayName || 'there',
    contactName: (prospect.contact && prospect.contact.name) || undefined,
    category: business.category || business.niche || business.industry || undefined,
    location: business.location || business.city || business.region || undefined,
    partnershipAngle: personalization.suggestedAngle || personalization.partnershipAngle || undefined
  };
}

module.exports = {
  EXCLUDED_STAGES,
  hasEmail,
  selectOutreachCandidates,
  buildEmailJobContext
};
