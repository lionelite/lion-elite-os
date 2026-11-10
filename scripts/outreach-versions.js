#!/usr/bin/env node
'use strict';

// Print the current clinic e-mail version ids and whether each is approved.
// Approving one is the owner's act: add the id to OUTREACH_APPROVED_MESSAGE_VERSIONS
// (comma-separated) on the outreach worker in the Render dashboard.

const { templateVersion, buildClinicSupplyEmail } = require('../lib/outreach/clinic-supply-email');
const { isApprovedVersion } = require('../lib/outreach/approved-message-versions');

const sample = buildClinicSupplyEmail({ businessName: 'Example Med Spa', category: 'med-spa', market: 'miami-fl' });
const id = templateVersion(1);
console.log(`Clinic supply e-mail 1 (sent automatically): ${id}  ${isApprovedVersion(id) ? 'APPROVED' : 'not approved'}`);
console.log('\nWhat it says (for Example Med Spa in Miami):\n');
console.log(`Subject: ${sample.subject}\n\n${sample.body}`);
console.log(`\nTo approve it, set on the outreach worker:\n  OUTREACH_APPROVED_MESSAGE_VERSIONS=${id}`);

// The one follow-up sent to clinics already contacted (stage `contacted`) by the
// HTTP-triggered run (POST /api/cron/clinic-outreach).
const { buildClinicFollowUpEmail, followUpVersion } = require('../lib/outreach/clinic-followup-email');
const followUp = buildClinicFollowUpEmail({ businessName: 'Example Med Spa', category: 'med-spa' });
const followUpId = followUpVersion();
console.log(`\n\nClinic follow-up (one per contacted clinic): ${followUpId}  ${isApprovedVersion(followUpId) ? 'APPROVED' : 'not approved'}`);
console.log(`\nWhat it says (${followUp.messageWordCount} words before the signature):\n`);
console.log(`Subject: ${followUp.subject}\n\n${followUp.body}`);
console.log(`\nTo approve both, set on the lion-elite-os web service:\n  OUTREACH_APPROVED_MESSAGE_VERSIONS=${id},${followUpId}`);
