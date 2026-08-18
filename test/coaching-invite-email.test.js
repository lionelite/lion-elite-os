'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAndSendClientInvite, inviteEmailHtml } = require('../lib/coaching/invite-email');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('creates a seven-day one-time coaching invite and sends a branded app email', async () => {
  await withEnv({
    RESEND_API_KEY: 'test-key',
    COACHING_PUBLIC_URL: 'https://coach.example.com',
    COACHING_EMAIL_FROM: 'Lion Elite Coaching <coach@example.com>'
  }, async () => {
    const invites = [];
    const store = {
      async createInvite(clientId, tokenHash, expiresAt) {
        invites.push({ clientId, tokenHash, expiresAt });
      }
    };
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, async json() { return { id: 'email_123' }; } };
    };
    const client = { clientId: 'client_1', email: 'client@example.com', firstName: 'Joel' };
    const before = Date.now();
    const result = await createAndSendClientInvite(store, client, { fetchImpl });

    assert.equal(invites.length, 1);
    assert.equal(invites[0].clientId, 'client_1');
    assert.match(invites[0].tokenHash, /^[a-f0-9]{64}$/);
    assert.ok(new Date(invites[0].expiresAt).getTime() >= before + (7 * 24 * 60 * 60 * 1000) - 1000);
    assert.match(result.inviteUrl, /^https:\/\/coach\.example\.com\/coaching\/#invite=/);
    assert.equal(result.delivery.sent, true);
    assert.equal(result.delivery.id, 'email_123');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.resend.com/emails');
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.to, ['client@example.com']);
    assert.equal(body.subject, 'Your Lion Elite coaching app is ready');
    assert.match(body.html, /Open Lion Elite App/);
    assert.match(body.html, /Add to Home Screen/);
  });
});

test('email HTML escapes client-controlled content', () => {
  const html = inviteEmailHtml({ firstName: '<script>alert(1)</script>' }, 'https://example.com/#invite=abc');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('missing email provider key keeps invite generation functional', async () => {
  await withEnv({ RESEND_API_KEY: null, COACHING_PUBLIC_URL: 'https://coach.example.com' }, async () => {
    let inviteCreated = false;
    const store = { async createInvite() { inviteCreated = true; } };
    const result = await createAndSendClientInvite(store, { clientId: 'client_2', email: 'x@example.com', firstName: 'X' });
    assert.equal(inviteCreated, true);
    assert.equal(result.delivery.sent, false);
    assert.equal(result.delivery.reason, 'RESEND_API_KEY_NOT_CONFIGURED');
  });
});
