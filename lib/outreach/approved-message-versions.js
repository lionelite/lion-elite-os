'use strict';

/**
 * Message versions approved for unattended sending. The validation engine's
 * `message_version_approved` check reads this through
 * lib/outreach/clinic-qualification.js.
 *
 * Approval is the owner's act, so it lives in an environment variable the owner
 * sets in the Render dashboard (OUTREACH_APPROVED_MESSAGE_VERSIONS, comma-
 * separated), exactly like OUTREACH_SEND_ENABLED. Nothing in code approves a
 * version: an approval written into the repo by whoever wrote the template is
 * not an approval.
 *
 * Version ids come from lib/outreach/clinic-supply-email.js templateVersion(),
 * a hash of the template source. Editing the wording produces a new id, which is
 * unapproved until the owner adds it, so an edit cannot inherit an approval
 * given to different words. `npm run outreach:versions` prints the current ids.
 */
function approvedVersions(env = process.env) {
  return String(env.OUTREACH_APPROVED_MESSAGE_VERSIONS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isApprovedVersion(versionId, env = process.env) {
  return Boolean(versionId) && approvedVersions(env).includes(versionId);
}

module.exports = { approvedVersions, isApprovedVersion };
