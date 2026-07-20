'use strict';

function present(value) {
  return Boolean(String(value || '').trim());
}

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function leadAutomationReadiness(env = process.env) {
  const blueskyCredentialsConfigured = present(env.BLUESKY_HANDLE) && present(env.BLUESKY_APP_PASSWORD);
  const databaseConfigured = present(env.DATABASE_URL);
  const botIdentityConfigured = present(env.BLUESKY_BOT_DID);
  const outreachEnabled = enabled(env.BLUESKY_OUTREACH_ENABLED);
  const outreachDryRun = !/^(0|false|no|off)$/i.test(String(env.BLUESKY_OUTREACH_DRY_RUN || '').trim());

  return {
    listenerReady: blueskyCredentialsConfigured && databaseConfigured,
    outreachReady: blueskyCredentialsConfigured && botIdentityConfigured && outreachEnabled && !outreachDryRun,
    digestReady: databaseConfigured && present(env.RESEND_API_KEY) && present(env.OUTREACH_FROM_EMAIL) && present(env.LEAD_DIGEST_TO),
    checks: {
      databaseConfigured,
      blueskyCredentialsConfigured,
      botIdentityConfigured,
      outreachEnabled,
      outreachDryRun
    }
  };
}

module.exports = { leadAutomationReadiness };
