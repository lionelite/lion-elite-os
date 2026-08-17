'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { MemoryCoachingStore } = require('../lib/coaching/store');
const { hashToken, secureEquals } = require('../lib/coaching/security');
const { sanitizeWorkoutPlan, videoDetails } = require('../lib/coaching/validation');
const { buildFallbackDraft } = require('../lib/coaching/workout-planner');
const { createCoachingRouter } = require('../routes/coaching');

function youtube(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

test('coaching security hashes raw access tokens and compares secrets safely', () => {
  assert.equal(hashToken('private-link-token').length, 64);
  assert.notEqual(hashToken('private-link-token'), 'private-link-token');
  assert.equal(secureEquals('same-value', 'same-value'), true);
  assert.equal(secureEquals('short', 'different-length'), false);
});

test('exercise videos must use HTTPS and supported providers become privacy-aware embeds', () => {
  assert.throws(() => videoDetails('http://example.com/demo.mp4'), /HTTPS/);
  assert.deepEqual(videoDetails(youtube('abcdefghijk')), {
    url: youtube('abcdefghijk'),
    kind: 'youtube',
    embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk'
  });
});

test('workout assistant uses only approved video exercises', () => {
  const exercises = ['squat', 'row', 'press'].map((name, index) => ({
    exerciseId: `00000000-0000-4000-8000-00000000000${index}`,
    name,
    active: true,
    equipment: 'bodyweight',
    instructions: `${name} coaching cues`,
    videoUrl: youtube(`abcdefghi${index}k`)
  }));
  const plan = buildFallbackDraft({ goal: 'strength', daysPerWeek: 2, sessionMinutes: 45, equipment: ['bodyweight'] }, exercises);
  assert.equal(plan.days.length, 2);
  assert.ok(plan.days.every(day => day.exercises.every(exercise => exercises.some(item => item.exerciseId === exercise.exerciseId))));
  assert.ok(plan.days.every(day => day.exercises.every(exercise => exercise.videoUrl.startsWith('https://'))));
});

test('workout plans cannot be sanitized without a video for every exercise', () => {
  assert.throws(() => sanitizeWorkoutPlan({
    title: 'Unsafe draft',
    days: [{ title: 'Day 1', exercises: [{ name: 'Squat', sets: [{ reps: '8' }] }] }]
  }), /video URL is required/i);
});

test('peptide protocols fail closed until clinician confirmation is recorded', async () => {
  const store = new MemoryCoachingStore();
  const client = await store.createClient({ email: 'client@example.com', firstName: 'Client', profile: {} });
  const protocol = await store.createProtocol(client.clientId, {
    title: 'Draft only', clinicianName: '', clinicianConfirmed: false,
    items: [{ name: 'Item', instructions: 'Clinician instruction' }], notes: ''
  });
  await assert.rejects(() => store.publishCarePlan('protocol', protocol.protocolId), /licensed clinician/i);
});

test('coach invite → client PWA → workout and messaging flow works end to end', async t => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (previousOpenAIKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
  });

  const store = new MemoryCoachingStore();
  const app = express();
  app.use(express.json());
  app.use('/api/coaching', createCoachingRouter({
    store,
    adminToken: 'test-admin-token',
    pushService: { configured: false, publicKey: '', notifyMessage: async () => ({ sent: 0 }) }
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
    const payload = await response.json();
    const setCookie = response.headers.get('set-cookie');
    return { response, payload, setCookie, cookie: setCookie?.split(';')[0] };
  }

  const login = await request('/auth/coach', { method: 'POST', body: { token: 'test-admin-token' } });
  assert.equal(login.response.status, 200);
  assert.match(login.cookie, /^lion_coaching_session=/);
  assert.match(login.setCookie, /Path=\/api\/coaching/);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  assert.equal(login.response.headers.get('cache-control'), 'no-store');

  const crossSite = await request('/admin/clients', {
    method: 'POST', cookie: login.cookie, body: { email: 'blocked@example.com', firstName: 'Blocked' },
    headers: { 'sec-fetch-site': 'cross-site' }
  });
  assert.equal(crossSite.response.status, 403);

  const created = await request('/admin/clients', {
    method: 'POST', cookie: login.cookie,
    body: {
      email: 'joel@example.com', firstName: 'Joel', lastName: 'Client',
      profile: { goal: 'Build strength', daysPerWeek: 2, sessionMinutes: 45, equipment: ['bodyweight'] }
    }
  });
  assert.equal(created.response.status, 201);
  const clientId = created.payload.client.clientId;

  for (const [index, name] of ['Squat', 'Push Up', 'Row'].entries()) {
    const exercise = await request('/admin/exercises', {
      method: 'POST', cookie: login.cookie,
      body: { name, muscleGroup: 'full body', equipment: 'bodyweight', instructions: `${name} cues`, videoUrl: youtube(`abcdefghi${index}k`) }
    });
    assert.equal(exercise.response.status, 201);
  }

  const draft = await request(`/admin/clients/${clientId}/workout-draft`, {
    method: 'POST', cookie: login.cookie,
    body: { profile: { goal: 'Build strength', daysPerWeek: 2, sessionMinutes: 45 } }
  });
  assert.equal(draft.response.status, 201);
  assert.equal(draft.payload.mode, 'rule-based');
  assert.equal(draft.payload.plan.status, 'draft');

  const published = await request(`/admin/workout-plans/${draft.payload.plan.planId}/publish`, {
    method: 'POST', cookie: login.cookie, body: {}
  });
  assert.equal(published.response.status, 200);
  assert.equal(published.payload.plan.status, 'published');

  const nutrition = await request(`/admin/clients/${clientId}/nutrition-plans`, {
    method: 'POST', cookie: login.cookie,
    body: { title: 'Performance foundation', calorieTarget: 2300, proteinGrams: 180, carbohydrateGrams: 240, fatGrams: 70, guidance: 'Coach-authored guidance.', meals: [] }
  });
  assert.equal(nutrition.response.status, 201);
  assert.equal((await request(`/admin/care-plans/nutrition/${nutrition.payload.plan.nutritionPlanId}/publish`, { method: 'POST', cookie: login.cookie, body: {} })).response.status, 200);

  const supplements = await request(`/admin/clients/${clientId}/supplement-plans`, {
    method: 'POST', cookie: login.cookie,
    body: { title: 'Clinician-reviewed fundamentals', items: [{ name: 'Example item', amount: 'label-directed', timing: 'with a meal', notes: 'Confirm with clinician' }], notes: '' }
  });
  assert.equal(supplements.response.status, 201);
  assert.equal((await request(`/admin/care-plans/supplements/${supplements.payload.plan.supplementPlanId}/publish`, { method: 'POST', cookie: login.cookie, body: {} })).response.status, 200);

  const protocol = await request(`/admin/clients/${clientId}/protocols`, {
    method: 'POST', cookie: login.cookie,
    body: { title: 'Display record', clinicianName: 'Dr. Example', clinicianConfirmed: true, items: [{ name: 'Clinician-directed item', instructions: 'Follow the written clinician instruction.', schedule: '', notes: '' }], notes: '' }
  });
  assert.equal(protocol.response.status, 201);
  assert.equal((await request(`/admin/care-plans/protocol/${protocol.payload.plan.protocolId}/publish`, { method: 'POST', cookie: login.cookie, body: {} })).response.status, 200);

  const invite = await request(`/admin/clients/${clientId}/invites`, { method: 'POST', cookie: login.cookie, body: {} });
  assert.equal(invite.response.status, 201);
  const inviteUrl = new URL(invite.payload.invite.url);
  assert.equal(inviteUrl.search, '', 'new invite secrets must not use query strings');
  const rawInvite = new URLSearchParams(inviteUrl.hash.slice(1)).get('invite');
  assert.ok(rawInvite);
  assert.ok(!JSON.stringify(store.auditEvents).includes(rawInvite), 'raw invite tokens must never enter audit logs');

  const clientLogin = await request('/auth/invite', { method: 'POST', body: { token: rawInvite } });
  assert.equal(clientLogin.response.status, 200);
  assert.match(clientLogin.cookie, /^lion_coaching_session=/);

  const reusedInvite = await request('/auth/invite', { method: 'POST', body: { token: rawInvite } });
  assert.equal(reusedInvite.response.status, 401, 'invite link must be single use');

  const missingAcknowledgement = await request('/profile', {
    method: 'PATCH', cookie: clientLogin.cookie,
    body: { coachingAcknowledged: false, profile: { goal: 'Get stronger' } }
  });
  assert.equal(missingAcknowledgement.response.status, 400);

  const onboarding = await request('/profile', {
    method: 'PATCH', cookie: clientLogin.cookie,
    body: {
      coachingAcknowledged: true,
      profile: {
        goal: 'Build strength and consistency', experienceLevel: 'intermediate', daysPerWeek: 3, sessionMinutes: 50,
        equipment: ['bodyweight', 'dumbbell'], limitations: 'Avoid painful ranges', dietaryPreferences: 'Simple meals',
        allergies: 'None known', typicalSleepHours: 7.5, primaryObstacle: 'Travel', preferredCheckInDay: 'Friday'
      }
    }
  });
  assert.equal(onboarding.response.status, 200);
  assert.equal(onboarding.payload.client.profile.goal, 'Build strength and consistency');
  assert.equal(onboarding.payload.client.profile.typicalSleepHours, 7.5);
  assert.ok(onboarding.payload.client.profile.onboardingCompletedAt);
  assert.ok(onboarding.payload.client.profile.coachingAcknowledgedAt);
  assert.ok(store.auditEvents.some(event => event.actorType === 'client' && event.eventType === 'client.profile.updated'));

  const dashboard = await request('/dashboard', { cookie: clientLogin.cookie });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.payload.dashboard.workoutPlan.days.length, 2);
  assert.ok(dashboard.payload.dashboard.workoutPlan.days.every(day => day.exercises.every(exercise => exercise.videoUrl)));
  assert.equal(dashboard.payload.dashboard.nutrition.title, 'Performance foundation');
  assert.equal(dashboard.payload.dashboard.supplements.title, 'Clinician-reviewed fundamentals');
  assert.equal(dashboard.payload.dashboard.protocol.clinicianConfirmed, true);
  assert.equal(dashboard.payload.dashboard.client.profile.preferredCheckInDay, 'Friday');

  const firstDay = dashboard.payload.dashboard.workoutPlan.days[0];
  const workoutLog = await request(`/workout-days/${firstDay.workoutDayId}/logs`, {
    method: 'POST', cookie: clientLogin.cookie,
    body: {
      status: 'completed', effort: 7, feedback: 'Strong session.',
      performance: firstDay.exercises.map(exercise => ({
        workoutExerciseId: exercise.workoutExerciseId,
        sets: exercise.sets.map(set => ({ reps: set.reps, weight: '', completed: true }))
      }))
    }
  });
  assert.equal(workoutLog.response.status, 201);

  const sent = await request('/messages', { method: 'POST', cookie: clientLogin.cookie, body: { body: 'Workout completed.' } });
  assert.equal(sent.response.status, 201);
  const coachMessages = await request(`/admin/clients/${clientId}/messages`, { cookie: login.cookie });
  assert.equal(coachMessages.payload.messages.at(-1).body, 'Workout completed.');
});

test('schema and PWA shell include the required durable/installable pieces', () => {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'db/schema.sql'), 'utf8');
  for (const table of ['coaching_clients', 'coaching_sessions', 'coaching_workout_plans', 'coaching_messages', 'coaching_checkins', 'coaching_push_subscriptions', 'coaching_audit_events']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/coaching/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/coaching/');
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
  const serviceWorker = fs.readFileSync(path.join(root, 'public/coaching/sw.js'), 'utf8');
  assert.match(serviceWorker, /addEventListener\('push'/);
  assert.doesNotMatch(serviceWorker, /\/api\/coaching.*cache\.put/s, 'authenticated API responses must not be cached');
});
