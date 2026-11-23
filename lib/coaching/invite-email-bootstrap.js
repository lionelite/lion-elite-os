'use strict';

const { MemoryCoachingStore, PostgresCoachingStore } = require('./store');
const { createAndSendClientInvite } = require('./invite-email');

const PATCHED = Symbol.for('lionelite.coachingInviteEmailPatched');

function patchStore(StoreClass) {
  if (!StoreClass?.prototype || StoreClass.prototype[PATCHED]) return;
  const originalCreateClient = StoreClass.prototype.createClient;
  if (typeof originalCreateClient !== 'function') return;

  Object.defineProperty(StoreClass.prototype, PATCHED, { value: true });
  StoreClass.prototype.createClient = async function createClientWithInvite(input) {
    const client = await originalCreateClient.call(this, input);
    try {
      const result = await createAndSendClientInvite(this, client);
      if (typeof this.audit === 'function') {
        await this.audit(client.clientId, 'system', 'invite.email.delivery', {
          sent: result.delivery.sent,
          reason: result.delivery.reason || null,
          providerId: result.delivery.id || null,
          expiresAt: result.expiresAt
        });
      }
      console.log(`[coaching] onboarding invite ${result.delivery.sent ? 'emailed' : 'created'} for ${client.email}`);
    } catch (error) {
      // Client creation must remain successful even if the email provider is down.
      console.error(`[coaching] onboarding invite email failed for ${client.email}: ${error.message}`);
      if (typeof this.audit === 'function') {
        await this.audit(client.clientId, 'system', 'invite.email.failed', { message: error.message }).catch(() => {});
      }
    }
    return client;
  };
}

function installAutomaticCoachingInvites() {
  patchStore(PostgresCoachingStore);
  patchStore(MemoryCoachingStore);
}

module.exports = {
  installAutomaticCoachingInvites,
  patchStore
};
