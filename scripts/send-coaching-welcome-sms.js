#!/usr/bin/env node
'use strict';

// Runs the coaching welcome SMS campaign.
//
//   node scripts/send-coaching-welcome-sms.js --dry-run   inspect selection + copy
//   node scripts/send-coaching-welcome-sms.js             send, if every gate allows
//
// Sending additionally requires SMS_SEND_ENABLED=true and Twilio credentials,
// both owner-set. Without them a real run reports why it did nothing and exits
// 0 — that is the designed state, not a failure.

const leadStore = require('../lib/leads/lead-store');
const { sendTwilioMessage } = require('../lib/sms-outreach');
const { isHalted } = require('../lib/kill-switch');
const { runWelcomeCampaign, dailyLimit } = require('../lib/sms/welcome-sender');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const summary = await runWelcomeCampaign({
    dryRun,
    limit: Number(process.env.SMS_BATCH_LIMIT || 50),
    loadCandidates: options => leadStore.listWelcomeCandidates(options),
    markSent: (lead, campaignId) => leadStore.markSmsSent(lead, campaignId),
    reserveQuota: limit => leadStore.reserveSmsQuota(limit),
    // A dry run must not depend on Redis being reachable.
    isHalted: dryRun ? async () => false : isHalted,
    sendMessage: ({ to, body }) => sendTwilioMessage({
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
      from: process.env.TWILIO_FROM_NUMBER,
      to,
      body
    })
  });

  const reasons = summary.skipped.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] || 0) + 1;
    return acc;
  }, {});

  console.log(JSON.stringify({
    campaign: summary.campaign,
    dryRun: summary.dryRun,
    blocked: summary.blocked,
    dailyLimit: dailyLimit(),
    sent: summary.sent,
    skipped: reasons
  }, null, 2));

  if (dryRun) {
    for (const item of summary.skipped.filter(s => s.reason === 'dry_run')) {
      console.log(`\n  would text ${item.id}:\n  ${item.body}`);
    }
  }
}

main().catch(error => {
  console.error(`[welcome-sms] ${error.stack || error.message}`);
  process.exitCode = 1;
});
