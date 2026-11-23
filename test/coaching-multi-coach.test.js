'use strict';

// Multi-coach isolation.
//
// Before coaches had identities, one shared COACH_PORTAL_ADMIN_TOKEN granted
// every coach session access to every client. These tests pin the boundary:
// a coach reaches their own roster and nothing else, and the failure mode for
// someone else's client is 404 (not 403) so ids cannot be probed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { MemoryCoachingStore } = require('../lib/coaching/store');
const { createCoachingRouter } = require('../routes/coaching');

const ADMIN_TOKEN = 'owner-admin-token';

async function harness(t) {
  const store = new MemoryCoachingStore();
  const pushed = [];
  const app = express();
  app.use(express.json());
  app.use('/api/coaching', createCoachingRouter({
    store,
    adminToken: ADMIN_TOKEN,
    ownerName: 'Owner Coach',
    pushService: {
      configured: true,
      publicKey: 'test',
      notifyMessage: async payload => { pushed.push(payload); return { sent: 0 }; }
    }
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(urlPath, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(`${base}/api/coaching${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json', origin: base } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }

  async function signIn(token) {
    const login = await request('/auth/coach', { method: 'POST', body: { token } });
    return login;
  }

  /** Owner signs in, creates a coach, and returns that coach's session. */
  async function addCoach(ownerCookie, { name, email }) {
    const created = await request('/admin/coaches', { method: 'POST', cookie: ownerCookie, body: { name, email } });
    assert.equal(created.status, 201);
    const session = await signIn(created.payload.accessToken);
    assert.equal(session.status, 200);
    return { coach: created.payload.coach, accessToken: created.payload.accessToken, cookie: session.cookie };
  }

  async function addClient(cookie, { firstName, email }) {
    const created = await request('/admin/clients', { method: 'POST', cookie, body: { firstName, email } });
    assert.equal(created.status, 201);
    return created.payload.client;
  }

  return { store, request, signIn, addCoach, addClient, pushed };
}

test('the admin token bootstraps one owner and claims pre-existing clients', async t => {
  const { store, request, signIn } = await harness(t);

  // A client created before multi-coach existed has no coach_id.
  const orphan = await store.createClient({ email: 'orphan@example.com', firstName: 'Orphan' });
  assert.equal(orphan.coachId, null);

  const first = await signIn(ADMIN_TOKEN);
  assert.equal(first.status, 200);
  assert.equal(first.payload.actor.coach.role, 'owner');
  assert.equal(first.payload.actor.coach.name, 'Owner Coach');

  const roster = await request('/admin/clients', { cookie: first.cookie });
  assert.equal(roster.payload.clients.length, 1, 'the orphaned client is claimed, not stranded');
  assert.equal(roster.payload.clients[0].coachId, first.payload.actor.coach.coachId);

  // Signing in again must not mint a second owner.
  const second = await signIn(ADMIN_TOKEN);
  assert.equal(second.payload.actor.coach.coachId, first.payload.actor.coach.coachId);
  assert.equal((await store.listCoaches()).length, 1);
});

test('a coach sees only their own roster', async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);

  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const bob = await addCoach(owner.cookie, { name: 'Bob', email: 'bob@example.com' });

  const aliceClient = await addClient(alice.cookie, { firstName: 'AliceClient', email: 'ac@example.com' });
  await addClient(bob.cookie, { firstName: 'BobClient', email: 'bc@example.com' });

  const aliceRoster = await request('/admin/clients', { cookie: alice.cookie });
  assert.deepEqual(aliceRoster.payload.clients.map(c => c.firstName), ['AliceClient']);

  const bobRoster = await request('/admin/clients', { cookie: bob.cookie });
  assert.deepEqual(bobRoster.payload.clients.map(c => c.firstName), ['BobClient']);

  // The owner still sees everything.
  const ownerRoster = await request('/admin/clients', { cookie: owner.cookie });
  assert.equal(ownerRoster.payload.clients.length, 2);

  // A new client is owned by its creating coach.
  assert.equal(aliceClient.coachId, alice.coach.coachId);
});

test("every client-addressed route answers 404 for another coach's client", async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const bob = await addCoach(owner.cookie, { name: 'Bob', email: 'bob@example.com' });
  const target = await addClient(bob.cookie, { firstName: 'BobClient', email: 'bc@example.com' });

  const attempts = [
    ['GET', `/admin/clients/${target.clientId}`, undefined],
    ['PATCH', `/admin/clients/${target.clientId}`, { firstName: 'Hijacked', email: 'bc@example.com' }],
    ['POST', `/admin/clients/${target.clientId}/invites`, {}],
    ['GET', `/admin/clients/${target.clientId}/messages`, undefined],
    ['POST', `/admin/clients/${target.clientId}/messages`, { body: 'hello' }],
    ['POST', `/admin/clients/${target.clientId}/nutrition-plans`, { title: 'Plan' }],
    ['POST', `/admin/clients/${target.clientId}/supplement-plans`, { title: 'Plan' }],
    ['POST', `/admin/clients/${target.clientId}/protocols`, { title: 'Plan' }],
    ['POST', `/admin/clients/${target.clientId}/workout-plans`, { title: 'Plan', days: [] }],
    ['POST', `/admin/clients/${target.clientId}/workout-draft`, {}]
  ];

  for (const [method, path, body] of attempts) {
    const result = await request(path, { method, cookie: alice.cookie, body });
    assert.equal(result.status, 404, `${method} ${path} must not confirm the client exists`);
  }

  // The stream is a read of that client too.
  const stream = await request(`/messages/stream?clientId=${target.clientId}`, { cookie: alice.cookie });
  assert.equal(stream.status, 404);

  // Bob is unaffected.
  const allowed = await request(`/admin/clients/${target.clientId}`, { cookie: bob.cookie });
  assert.equal(allowed.status, 200);
});

test("a coach cannot publish another coach's care plan or workout plan", async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const bob = await addCoach(owner.cookie, { name: 'Bob', email: 'bob@example.com' });
  const client = await addClient(bob.cookie, { firstName: 'BobClient', email: 'bc@example.com' });

  const nutrition = await request(`/admin/clients/${client.clientId}/nutrition-plans`, {
    method: 'POST', cookie: bob.cookie, body: { title: 'Cut' }
  });
  assert.equal(nutrition.status, 201);

  const stolen = await request(`/admin/care-plans/nutrition/${nutrition.payload.plan.nutritionPlanId}/publish`, {
    method: 'POST', cookie: alice.cookie, body: {}
  });
  assert.equal(stolen.status, 404);

  const legitimate = await request(`/admin/care-plans/nutrition/${nutrition.payload.plan.nutritionPlanId}/publish`, {
    method: 'POST', cookie: bob.cookie, body: {}
  });
  assert.equal(legitimate.status, 200);

  // Workout plans come from the drafting route, which needs a stocked library.
  for (const [index, name] of ['Squat', 'Push Up', 'Row'].entries()) {
    const exercise = await request('/admin/exercises', {
      method: 'POST', cookie: bob.cookie,
      body: {
        name, muscleGroup: 'full body', equipment: 'bodyweight', instructions: `${name} cues`,
        videoUrl: `https://www.youtube.com/watch?v=abcdefghi${index}k`
      }
    });
    assert.equal(exercise.status, 201);
  }
  const draft = await request(`/admin/clients/${client.clientId}/workout-draft`, {
    method: 'POST', cookie: bob.cookie,
    body: { profile: { goal: 'Build strength', daysPerWeek: 2, sessionMinutes: 45 } }
  });
  assert.equal(draft.status, 201);
  const hijack = await request(`/admin/workout-plans/${draft.payload.plan.planId}/publish`, {
    method: 'POST', cookie: alice.cookie, body: {}
  });
  assert.equal(hijack.status, 404);
  assert.equal((await request(`/admin/workout-plans/${draft.payload.plan.planId}/publish`, {
    method: 'POST', cookie: bob.cookie, body: {}
  })).status, 200);
});

test('coach administration is owner-only', async t => {
  const { request, signIn, addCoach } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });

  assert.equal((await request('/admin/coaches', { cookie: alice.cookie })).status, 403);
  assert.equal((await request('/admin/coaches', {
    method: 'POST', cookie: alice.cookie, body: { name: 'Sneak', email: 'sneak@example.com' }
  })).status, 403);
  assert.equal((await request(`/admin/coaches/${alice.coach.coachId}`, {
    method: 'PATCH', cookie: alice.cookie, body: { status: 'suspended' }
  })).status, 403);

  // A coach can still read their own identity.
  const me = await request('/admin/me', { cookie: alice.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.payload.coach.name, 'Alice');
  assert.equal(me.payload.coach.role, 'coach');
});

test('a non-owner cannot assign a client to another coach', async t => {
  const { request, signIn, addCoach } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const bob = await addCoach(owner.cookie, { name: 'Bob', email: 'bob@example.com' });

  const attempt = await request('/admin/clients', {
    method: 'POST', cookie: alice.cookie,
    body: { firstName: 'Planted', email: 'planted@example.com', coachId: bob.coach.coachId }
  });
  assert.equal(attempt.status, 400);

  // The owner may.
  const assigned = await request('/admin/clients', {
    method: 'POST', cookie: owner.cookie,
    body: { firstName: 'Handoff', email: 'handoff@example.com', coachId: bob.coach.coachId }
  });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.payload.client.coachId, bob.coach.coachId);
});

test('suspending or rotating ends the sessions that coach already holds', async t => {
  const { request, signIn, addCoach } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });

  assert.equal((await request('/admin/clients', { cookie: alice.cookie })).status, 200);

  const suspended = await request(`/admin/coaches/${alice.coach.coachId}`, {
    method: 'PATCH', cookie: owner.cookie, body: { status: 'suspended' }
  });
  assert.equal(suspended.status, 200);
  assert.equal((await request('/admin/clients', { cookie: alice.cookie })).status, 403,
    'a live cookie must stop working the moment the account is suspended');

  // Reinstating, then rotating, also invalidates the old session.
  await request(`/admin/coaches/${alice.coach.coachId}`, { method: 'PATCH', cookie: owner.cookie, body: { status: 'active' } });
  const back = await signIn(alice.accessToken);
  assert.equal(back.status, 200);
  assert.equal((await request('/admin/clients', { cookie: back.cookie })).status, 200);

  const rotated = await request(`/admin/coaches/${alice.coach.coachId}/token`, { method: 'POST', cookie: owner.cookie, body: {} });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.payload.accessToken, alice.accessToken);
  assert.equal((await request('/admin/clients', { cookie: back.cookie })).status, 403);
  assert.equal((await signIn(alice.accessToken)).status, 401, 'the old token is dead');
  assert.equal((await signIn(rotated.payload.accessToken)).status, 200);
});

test('an owner cannot suspend themselves out of coach administration', async t => {
  const { request, signIn } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const result = await request(`/admin/coaches/${owner.payload.actor.coach.coachId}`, {
    method: 'PATCH', cookie: owner.cookie, body: { status: 'suspended' }
  });
  assert.equal(result.status, 400);
});

test('messages carry the sending coach and alert only that coach', async t => {
  const { request, signIn, addCoach, addClient, pushed } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const client = await addClient(alice.cookie, { firstName: 'Casey', email: 'casey@example.com' });

  const sent = await request(`/admin/clients/${client.clientId}/messages`, {
    method: 'POST', cookie: alice.cookie, body: { body: 'Welcome aboard.' }
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.payload.message.senderName, 'Alice', 'not the old hardcoded name');

  const clientAlert = pushed.at(-1);
  assert.equal(clientAlert.senderType, 'coach');
  assert.equal(clientAlert.coachId, alice.coach.coachId);
});

test("a coach push subscription never receives another coach's client alerts", async t => {
  const { store, signIn, addCoach } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const bob = await addCoach(owner.cookie, { name: 'Bob', email: 'bob@example.com' });

  const subscribe = (coachId, endpoint) => store.savePushSubscription('coach', null, {
    endpoint, keys: { p256dh: 'k', auth: 'a' }
  }, coachId);

  await subscribe(alice.coach.coachId, 'https://push.example.com/alice');
  await subscribe(bob.coach.coachId, 'https://push.example.com/bob');

  const forAlice = await store.listPushSubscriptions('coach', null, alice.coach.coachId);
  assert.deepEqual(forAlice.map(s => s.endpoint), ['https://push.example.com/alice']);

  const forBob = await store.listPushSubscriptions('coach', null, bob.coach.coachId);
  assert.deepEqual(forBob.map(s => s.endpoint), ['https://push.example.com/bob']);
});

test('editing a client never moves it to another roster', async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const client = await addClient(alice.cookie, { firstName: 'Casey', email: 'casey@example.com' });

  const updated = await request(`/admin/clients/${client.clientId}`, {
    method: 'PATCH', cookie: alice.cookie,
    body: { firstName: 'Casey', lastName: 'Renamed', email: 'casey@example.com', status: 'paused' }
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.client.coachId, alice.coach.coachId, 'a plain edit must not orphan or reassign the client');

  const roster = await request('/admin/clients', { cookie: alice.cookie });
  assert.equal(roster.payload.clients.length, 1);
});

// The clinician_confirmed boolean records that a box was ticked. These pin the
// evidence behind it: a protocol cannot reach a client without a named licence,
// verified by a real coach, with the client's consent on record.
test('a protocol cannot be confirmed without the licence it stands on', async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const client = await addClient(alice.cookie, { firstName: 'Casey', email: 'casey@example.com' });

  const items = [{ name: 'Item', instructions: 'Follow the written clinician instruction.', schedule: '', notes: '' }];

  const withoutLicence = await request(`/admin/clients/${client.clientId}/protocols`, {
    method: 'POST', cookie: alice.cookie,
    body: { title: 'P', clinicianName: 'Dr. Example', clinicianConfirmed: true, items, notes: '' }
  });
  assert.equal(withoutLicence.status, 400, 'confirming without licence details must be refused');

  // An unconfirmed draft still needs no licence — it cannot reach a client.
  const draft = await request(`/admin/clients/${client.clientId}/protocols`, {
    method: 'POST', cookie: alice.cookie,
    body: { title: 'P', clinicianName: '', clinicianConfirmed: false, items, notes: '' }
  });
  assert.equal(draft.status, 201);
  const blocked = await request(`/admin/care-plans/protocol/${draft.payload.plan.protocolId}/publish`, {
    method: 'POST', cookie: alice.cookie, body: {}
  });
  assert.equal(blocked.status, 422, 'an unconfirmed protocol still cannot be published');
});

test('a complete protocol publishes and records who verified the licence', async t => {
  const { request, signIn, addCoach, addClient } = await harness(t);
  const owner = await signIn(ADMIN_TOKEN);
  const alice = await addCoach(owner.cookie, { name: 'Alice', email: 'alice@example.com' });
  const client = await addClient(alice.cookie, { firstName: 'Casey', email: 'casey@example.com' });

  const created = await request(`/admin/clients/${client.clientId}/protocols`, {
    method: 'POST', cookie: alice.cookie,
    body: {
      title: 'P', clinicianName: 'Dr. Example', clinicianConfirmed: true,
      clinicianLicenseType: 'MD', clinicianLicenseNumber: 'EXAMPLE-0000', clinicianLicenseState: 'OH',
      consentObtainedAt: '2026-03-01',
      items: [{ name: 'Item', instructions: 'Follow the written clinician instruction.', schedule: '', notes: '' }],
      notes: ''
    }
  });
  assert.equal(created.status, 201);
  // The verifier is server-side truth, not a submitted value.
  assert.equal(created.payload.plan.clinicianVerifiedBy, 'Alice');
  assert.ok(created.payload.plan.clinicianVerifiedAt, 'verification time is stamped at confirmation');

  const published = await request(`/admin/care-plans/protocol/${created.payload.plan.protocolId}/publish`, {
    method: 'POST', cookie: alice.cookie, body: {}
  });
  assert.equal(published.status, 200);
  assert.equal(published.payload.plan.status, 'published');
});
