'use strict';

const { runCampaign } = require('../lib/sms-outreach');

function hasFlag(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const send = hasFlag('--send');
  const days = Number(valueAfter('--days', process.env.SMS_OUTREACH_DAYS || 45));
  const result = await runCampaign({
    send,
    days,
    shop: process.env.SHOPIFY_SHOP_DOMAIN,
    shopifyAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    shopifyApiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioMessagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER,
    statusCallback: process.env.TWILIO_STATUS_CALLBACK_URL,
    messageTemplate: process.env.SMS_OUTREACH_MESSAGE
  });

  console.log(JSON.stringify(result, null, 2));
  if (!send) {
    console.error('\nDry run only. Review the eligible recipients, then rerun with --send.');
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
