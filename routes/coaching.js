'use strict';

const express = require('express');
const {
  assertSameOrigin,
  clearSessionCookie,
  generateToken,
  hashToken,
  secureEquals,
  sessionCookie,
  sessionTokenFromRequest
} = require('../lib/coaching/security');
const {
  badRequest,
  cleanArray,
  cleanEmail,
  cleanInteger,
  cleanNumber,
  cleanSlug,
  cleanText,
  sanitizeWorkoutPlan,
  videoDetails
} = require('../lib/coaching/validation');
const { generateWorkoutDraft } = require('../lib/coaching/workout-planner');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createRateLimiter({ windowMs, limit }) {
  const buckets = new Map();
  return (req, _res, next) => {
    const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.path}`;
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) {
      const error = new Error('Too many attempts. Wait a few minutes and try again.');
      error.statusCode = 429;
      return next(error);
    }
    if (buckets.size > 2000) {
      for (const [bucketKey, value] of buckets) if (value.resetAt <= now) buckets.delete(bucketKey);
    }
    next();
  };
}

function cleanProfile(value = {}) {
  const equipment = Array.isArray(value.equipment)
    ? value.equipment.map(item => cleanText(item, { field: 'Equipment', max: 80 })).filter(Boolean).slice(0, 30)
    : [];
  const experienceLevel = cleanText(value.experienceLevel || 'intermediate', { field: 'Experience level', max: 40 }).toLowerCase();
  const preferredCheckInDay = cleanText(value.preferredCheckInDay, { field: 'Preferred check-in day', max: 20 });
  const timestamp = input => {
    if (!input) return null;
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  return {
    goal: cleanText(value.goal, { field: 'Goal', max: 500 }),
    experienceLevel: ['beginner', 'intermediate', 'advanced'].includes(experienceLevel) ? experienceLevel : 'intermediate',
    daysPerWeek: cleanInteger(value.daysPerWeek ?? 3, { field: 'Training days', min: 1, max: 7, nullable: false }),
    sessionMinutes: cleanInteger(value.sessionMinutes ?? 60, { field: 'Session length', min: 20, max: 180, nullable: false }),
    equipment,
    limitations: cleanText(value.limitations, { field: 'Limitations', max: 1500 }),
    dietaryPreferences: cleanText(value.dietaryPreferences, { field: 'Dietary preferences', max: 1000 }),
    allergies: cleanText(value.allergies, { field: 'Allergies', max: 1000 }),
    typicalSleepHours: cleanNumber(value.typicalSleepHours, { field: 'Typical sleep', min: 0, max: 24 }),
    primaryObstacle: cleanText(value.primaryObstacle, { field: 'Primary obstacle', max: 1500 }),
    preferredCheckInDay: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].includes(preferredCheckInDay) ? preferredCheckInDay : '',
    onboardingCompletedAt: timestamp(value.onboardingCompletedAt),
    coachingAcknowledgedAt: timestamp(value.coachingAcknowledgedAt),
    updatedByClientAt: timestamp(value.updatedByClientAt)
  };
}

function cleanExercise(value = {}) {
  const video = videoDetails(value.videoUrl);
  const name = cleanText(value.name, { field: 'Exercise name', max: 120, required: true });
  return {
    name,
    slug: cleanSlug(value.slug || name),
    muscleGroup: cleanText(value.muscleGroup || 'full body', { field: 'Muscle group', max: 80 }),
    equipment: cleanText(value.equipment || 'other', { field: 'Equipment', max: 80 }),
    instructions: cleanText(value.instructions, { field: 'Instructions', max: 2000 }),
    videoUrl: video.url,
    videoKind: video.kind,
    embedUrl: video.embedUrl
  };
}

function cleanNutritionPlan(value = {}) {
  const meals = cleanArray(value.meals || [], { field: 'Meals', max: 30 }).map((meal, index) => ({
    name: cleanText(meal?.name || `Meal ${index + 1}`, { field: 'Meal name', max: 100, required: true }),
    description: cleanText(meal?.description, { field: 'Meal description', max: 1000 }),
    calories: cleanInteger(meal?.calories, { field: 'Meal calories', min: 0, max: 5000 })
  }));
  return {
    title: cleanText(value.title, { field: 'Nutrition plan title', max: 120, required: true }),
    calorieTarget: cleanInteger(value.calorieTarget, { field: 'Calories', min: 500, max: 10000 }),
    proteinGrams: cleanInteger(value.proteinGrams, { field: 'Protein', min: 0, max: 1000 }),
    carbohydrateGrams: cleanInteger(value.carbohydrateGrams, { field: 'Carbohydrates', min: 0, max: 1500 }),
    fatGrams: cleanInteger(value.fatGrams, { field: 'Fat', min: 0, max: 500 }),
    guidance: cleanText(value.guidance, { field: 'Nutrition guidance', max: 4000 }),
    meals
  };
}

function cleanSupplementPlan(value = {}) {
  const items = cleanArray(value.items || [], { field: 'Supplements', max: 50 }).map(item => ({
    name: cleanText(item?.name, { field: 'Supplement name', max: 120, required: true }),
    amount: cleanText(item?.amount, { field: 'Supplement amount', max: 100 }),
    timing: cleanText(item?.timing, { field: 'Supplement timing', max: 160 }),
    notes: cleanText(item?.notes, { field: 'Supplement notes', max: 1000 })
  }));
  return {
    title: cleanText(value.title, { field: 'Supplement plan title', max: 120, required: true }),
    items,
    notes: cleanText(value.notes, { field: 'Supplement plan notes', max: 3000 })
  };
}

function cleanProtocol(value = {}) {
  const items = cleanArray(value.items || [], { field: 'Protocol items', max: 30 }).map(item => ({
    name: cleanText(item?.name, { field: 'Protocol item name', max: 120, required: true }),
    instructions: cleanText(item?.instructions, { field: 'Clinician instructions', max: 1000, required: true }),
    schedule: cleanText(item?.schedule, { field: 'Schedule', max: 300 }),
    notes: cleanText(item?.notes, { field: 'Protocol notes', max: 1000 })
  }));
  const clinicianConfirmed = value.clinicianConfirmed === true;
  const clinicianName = cleanText(value.clinicianName, { field: 'Clinician name', max: 120, required: clinicianConfirmed });
  return {
    title: cleanText(value.title, { field: 'Protocol title', max: 120, required: true }),
    clinicianName,
    clinicianConfirmed,
    items,
    notes: cleanText(value.notes, { field: 'Protocol notes', max: 3000 })
  };
}

function cleanWorkoutLog(value = {}) {
  const performance = cleanArray(value.performance || [], { field: 'Workout performance', max: 100 }).map(item => ({
    workoutExerciseId: cleanText(item?.workoutExerciseId, { field: 'Exercise ID', max: 80, required: true }),
    sets: cleanArray(item?.sets || [], { field: 'Logged sets', max: 20 }).map(set => ({
      reps: cleanText(set?.reps, { field: 'Completed reps', max: 30 }),
      weight: cleanText(set?.weight, { field: 'Weight', max: 30 }),
      completed: set?.completed === true
    }))
  }));
  const status = ['in_progress', 'completed', 'skipped'].includes(value.status) ? value.status : 'completed';
  return {
    status,
    performance,
    effort: cleanInteger(value.effort, { field: 'Effort', min: 1, max: 10 }),
    feedback: cleanText(value.feedback, { field: 'Workout feedback', max: 2000 })
  };
}

function cleanCheckin(value = {}) {
  return {
    weightLbs: cleanNumber(value.weightLbs, { field: 'Weight', min: 50, max: 1000 }),
    sleepHours: cleanNumber(value.sleepHours, { field: 'Sleep', min: 0, max: 24 }),
    energy: cleanInteger(value.energy, { field: 'Energy', min: 1, max: 10 }),
    adherence: cleanInteger(value.adherence, { field: 'Adherence', min: 1, max: 10 }),
    soreness: cleanInteger(value.soreness, { field: 'Soreness', min: 1, max: 10 }),
    notes: cleanText(value.notes, { field: 'Check-in notes', max: 3000 })
  };
}

function cleanPushSubscription(value = {}) {
  const endpoint = cleanText(value.endpoint, { field: 'Push endpoint', max: 2000, required: true });
  let url;
  try { url = new URL(endpoint); } catch { throw badRequest('Push subscription endpoint is invalid.'); }
  if (url.protocol !== 'https:') throw badRequest('Push subscription endpoint must use HTTPS.');
  const p256dh = cleanText(value.keys?.p256dh, { field: 'Push key', max: 500, required: true });
  const auth = cleanText(value.keys?.auth, { field: 'Push auth key', max: 500, required: true });
  return { endpoint, expirationTime: value.expirationTime || null, keys: { p256dh, auth } };
}

function createCoachingRouter({
  store,
  pushService,
  adminToken = process.env.COACH_PORTAL_ADMIN_TOKEN,
  // Identity for the owner account bootstrapped from adminToken. The name is
  // what clients see on coach messages, so it defaults to the name the portal
  // used before coaches had identities.
  ownerName = process.env.COACH_OWNER_NAME || 'Coach Alex',
  ownerEmail = process.env.COACH_OWNER_EMAIL || 'owner@lionelite.internal'
} = {}) {
  if (!store) throw new Error('Coaching store is required.');
  const router = express.Router();
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 12 });
  const messageLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 30 });
  const streams = new Map();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    next();
  });

  // Keyed by coach, not by the literal string 'coach'. A single shared bucket
  // delivered every client's messages to every signed-in coach.
  function streamKey(actor, clientId) {
    return actor.actorType === 'coach' ? `coach:${actor.coachId}` : `client:${clientId}`;
  }

  function broadcastMessage(message, coachId) {
    const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    const keys = [`client:${message.clientId}`];
    if (coachId) keys.push(`coach:${coachId}`);
    for (const key of keys) {
      for (const response of streams.get(key) || []) response.write(event);
    }
  }

  router.use(asyncRoute(async (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertSameOrigin(req);
    const rawToken = sessionTokenFromRequest(req);
    req.coachingSessionTokenHash = rawToken ? hashToken(rawToken) : '';
    req.coachingActor = req.coachingSessionTokenHash ? await store.getSession(req.coachingSessionTokenHash) : null;
    next();
  }));

  function requireAuth(req, _res, next) {
    if (!req.coachingActor) {
      const error = new Error('Sign in to continue.');
      error.statusCode = 401;
      return next(error);
    }
    next();
  }

  function requireCoach(req, _res, next) {
    if (!req.coachingActor || req.coachingActor.actorType !== 'coach') {
      const error = new Error('Coach access required.');
      error.statusCode = 403;
      return next(error);
    }
    next();
  }

  function isOwner(actor) {
    return actor?.actorType === 'coach' && actor?.coach?.role === 'owner';
  }

  function requireOwner(req, _res, next) {
    if (!isOwner(req.coachingActor)) {
      const error = new Error('Owner access required.');
      error.statusCode = 403;
      return next(error);
    }
    next();
  }

  function canAccessClient(actor, client) {
    if (!client || actor?.actorType !== 'coach') return false;
    return isOwner(actor) || (Boolean(client.coachId) && client.coachId === actor.coachId);
  }

  /**
   * Load :clientId and confirm the acting coach may see it.
   *
   * Answers 404 rather than 403 on purpose: a coach must not be able to probe
   * which client ids exist on another coach's roster.
   */
  const requireClientAccess = asyncRoute(async (req, _res, next) => {
    const client = await store.getClient(req.params.clientId);
    if (!canAccessClient(req.coachingActor, client)) {
      const error = new Error('Client not found.');
      error.statusCode = 404;
      return next(error);
    }
    req.scopedClient = client;
    next();
  });

  /** Same check, for routes addressed by a plan id instead of a client id. */
  async function assertClientAccessById(req, clientId) {
    const client = clientId ? await store.getClient(clientId) : null;
    if (!canAccessClient(req.coachingActor, client)) {
      const error = new Error('Plan not found.');
      error.statusCode = 404;
      throw error;
    }
    return client;
  }

  /** Owners see every client; every other coach sees only their own. */
  function rosterScope(actor) {
    return isOwner(actor) ? { coachId: null } : { coachId: actor.coachId };
  }

  function requireClient(req, _res, next) {
    if (!req.coachingActor || req.coachingActor.actorType !== 'client') {
      const error = new Error('Client access required.');
      error.statusCode = 403;
      return next(error);
    }
    next();
  }

  router.get('/config', (_req, res) => {
    res.json({
      appName: 'Lion Elite Coaching',
      installable: true,
      pushConfigured: Boolean(pushService?.configured),
      pushPublicKey: pushService?.publicKey || '',
      protocolPolicy: 'Peptide protocols are displayed only after licensed-clinician confirmation. The workout assistant never creates peptide, supplement, diet, or medical instructions.'
    });
  });

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'lion-elite-coaching', adminConfigured: Boolean(adminToken), pushConfigured: Boolean(pushService?.configured) });
  });

  router.post('/auth/coach', loginLimiter, asyncRoute(async (req, res) => {
    const supplied = cleanText(req.body?.token, { field: 'Coach access token', max: 500, required: true });

    // COACH_PORTAL_ADMIN_TOKEN is the owner's credential, and the upgrade path
    // from the single-shared-token model: signing in with it reconciles the
    // owner account and claims any client that predates per-coach ownership.
    // Every other coach authenticates against their own stored token hash.
    const coach = adminToken && secureEquals(supplied, adminToken)
      ? await store.ensureOwnerCoach({ tokenHash: hashToken(supplied), email: ownerEmail, name: ownerName })
      : await store.findCoachByTokenHash(hashToken(supplied));

    if (!coach) {
      const error = new Error('Coach access token is invalid.');
      error.statusCode = 401;
      throw error;
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await store.createSession(hashToken(token), 'coach', null, expiresAt, coach.coachId);
    res.set('Set-Cookie', sessionCookie(req, token));
    res.json({ actor: { actorType: 'coach', coach, expiresAt } });
  }));

  router.post('/auth/invite', loginLimiter, asyncRoute(async (req, res) => {
    const inviteToken = cleanText(req.body?.token, { field: 'Invitation token', max: 500, required: true });
    const client = await store.redeemInvite(hashToken(inviteToken));
    if (!client || client.status === 'archived') {
      const error = new Error('This invitation is invalid, expired, or already used. Ask your coach for a new link.');
      error.statusCode = 401;
      throw error;
    }
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await store.createSession(hashToken(token), 'client', client.clientId, expiresAt);
    res.set('Set-Cookie', sessionCookie(req, token));
    res.json({ actor: { actorType: 'client', client, expiresAt } });
  }));

  router.post('/auth/logout', asyncRoute(async (req, res) => {
    if (req.coachingSessionTokenHash) await store.deleteSession(req.coachingSessionTokenHash, req.coachingActor);
    res.set('Set-Cookie', clearSessionCookie(req));
    res.json({ signedOut: true });
  }));

  router.get('/session', (req, res) => res.json({ actor: req.coachingActor || null }));

  router.get('/admin/clients', requireCoach, asyncRoute(async (req, res) => {
    res.json({ clients: await store.listClients(rosterScope(req.coachingActor)) });
  }));
  router.post('/admin/clients', requireCoach, asyncRoute(async (req, res) => {
    // An owner may hand a new client straight to another coach; anyone else
    // only ever creates clients on their own roster.
    const requestedCoachId = cleanText(req.body?.coachId, { field: 'Coach ID', max: 80 });
    let coachId = req.coachingActor.coachId;
    if (requestedCoachId && requestedCoachId !== coachId) {
      if (!isOwner(req.coachingActor)) throw badRequest('Only an owner can assign a client to another coach.');
      const target = await store.getCoach(requestedCoachId);
      if (!target || target.status !== 'active') throw badRequest('That coach is not available.');
      coachId = target.coachId;
    }
    const client = await store.createClient({
      email: cleanEmail(req.body?.email),
      firstName: cleanText(req.body?.firstName, { field: 'First name', max: 80, required: true }),
      lastName: cleanText(req.body?.lastName, { field: 'Last name', max: 80 }),
      subscriptionId: cleanText(req.body?.subscriptionId, { field: 'Subscription ID', max: 160 }),
      profile: cleanProfile(req.body?.profile),
      coachId
    });
    res.status(201).json({ client });
  }));
  router.get('/admin/clients/:clientId', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    const client = req.scopedClient;
    res.json({ client, dashboard: await store.getDashboard(client.clientId), workoutPlans: await store.listWorkoutPlans(client.clientId) });
  }));
  router.patch('/admin/clients/:clientId', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    const existing = await store.getClient(req.params.clientId);
    if (!existing) { const error = new Error('Client not found.'); error.statusCode = 404; throw error; }
    const status = ['active', 'paused', 'archived'].includes(req.body?.status) ? req.body.status : existing.status;
    const client = await store.updateClient(existing.clientId, {
      email: req.body?.email ? cleanEmail(req.body.email) : existing.email,
      firstName: cleanText(req.body?.firstName ?? existing.firstName, { field: 'First name', max: 80, required: true }),
      lastName: cleanText(req.body?.lastName ?? existing.lastName, { field: 'Last name', max: 80 }),
      status,
      profile: cleanProfile(req.body?.profile || existing.profile)
    });
    res.json({ client });
  }));
  router.post('/admin/clients/:clientId/invites', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await store.createInvite(req.params.clientId, hashToken(token), expiresAt);
    const configuredBase = String(process.env.COACHING_PUBLIC_URL || '').replace(/\/$/, '');
    const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const base = configuredBase || `${forwardedProto || req.protocol}://${req.get('host')}`;
    // Keep the one-time secret after `#` so browsers never send it in the
    // HTTP request, referrer, reverse-proxy access log, or analytics URL.
    res.status(201).json({ invite: { url: `${base}/coaching/#invite=${encodeURIComponent(token)}`, expiresAt } });
  }));

  // --- Coach administration (owner only) -----------------------------------
  // Access tokens are shown exactly once, at creation and at rotation. Only
  // the hash is stored, so a lost token is rotated rather than recovered.

  router.get('/admin/me', requireCoach, (req, res) => res.json({ coach: req.coachingActor.coach }));

  router.get('/admin/coaches', requireCoach, requireOwner, asyncRoute(async (_req, res) => {
    res.json({ coaches: await store.listCoaches() });
  }));

  router.post('/admin/coaches', requireCoach, requireOwner, asyncRoute(async (req, res) => {
    const accessToken = generateToken();
    const coach = await store.createCoach({
      email: cleanEmail(req.body?.email),
      name: cleanText(req.body?.name, { field: 'Coach name', max: 120, required: true }),
      role: req.body?.role === 'owner' ? 'owner' : 'coach',
      tokenHash: hashToken(accessToken)
    });
    res.status(201).json({ coach, accessToken });
  }));

  router.patch('/admin/coaches/:coachId', requireCoach, requireOwner, asyncRoute(async (req, res) => {
    const status = req.body?.status === undefined ? undefined : cleanText(req.body.status, { field: 'Status', max: 20 });
    if (status !== undefined && !['active', 'suspended'].includes(status)) throw badRequest('Status must be active or suspended.');
    // Suspending yourself would lock the only owner out of coach administration.
    if (status === 'suspended' && req.params.coachId === req.coachingActor.coachId) {
      throw badRequest('You cannot suspend your own account.');
    }
    const coach = await store.updateCoach(req.params.coachId, {
      name: req.body?.name === undefined ? undefined : cleanText(req.body.name, { field: 'Coach name', max: 120, required: true }),
      status
    });
    res.json({ coach });
  }));

  router.post('/admin/coaches/:coachId/token', requireCoach, requireOwner, asyncRoute(async (req, res) => {
    const accessToken = generateToken();
    const coach = await store.rotateCoachToken(req.params.coachId, hashToken(accessToken));
    res.json({ coach, accessToken });
  }));

  router.get('/admin/exercises', requireCoach, asyncRoute(async (_req, res) => res.json({ exercises: await store.listExercises() })));
  router.post('/admin/exercises', requireCoach, asyncRoute(async (req, res) => res.status(201).json({ exercise: await store.createExercise(cleanExercise(req.body)) })));

  router.post('/admin/clients/:clientId/workout-plans', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    const plan = await store.createWorkoutPlan(req.params.clientId, sanitizeWorkoutPlan(req.body), 'manual');
    res.status(201).json({ plan });
  }));
  router.post('/admin/clients/:clientId/workout-draft', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    const client = await store.getClient(req.params.clientId);
    if (!client) { const error = new Error('Client not found.'); error.statusCode = 404; throw error; }
    const exercises = await store.listExercises();
    const profile = { ...client.profile, ...(req.body?.profile || {}) };
    const generated = await generateWorkoutDraft(profile, exercises);
    const plan = await store.createWorkoutPlan(client.clientId, generated.plan, 'assisted');
    res.status(201).json({ ...generated, plan });
  }));
  router.post('/admin/workout-plans/:planId/publish', requireCoach, asyncRoute(async (req, res) => {
    const existing = await store.getWorkoutPlan(req.params.planId);
    await assertClientAccessById(req, existing?.clientId);
    res.json({ plan: await store.publishWorkoutPlan(req.params.planId) });
  }));

  router.post('/admin/clients/:clientId/nutrition-plans', requireCoach, requireClientAccess, asyncRoute(async (req, res) => res.status(201).json({ plan: await store.createNutritionPlan(req.params.clientId, cleanNutritionPlan(req.body)) })));
  router.post('/admin/clients/:clientId/supplement-plans', requireCoach, requireClientAccess, asyncRoute(async (req, res) => res.status(201).json({ plan: await store.createSupplementPlan(req.params.clientId, cleanSupplementPlan(req.body)) })));
  router.post('/admin/clients/:clientId/protocols', requireCoach, requireClientAccess, asyncRoute(async (req, res) => res.status(201).json({ plan: await store.createProtocol(req.params.clientId, cleanProtocol(req.body)) })));
  router.post('/admin/care-plans/:kind/:id/publish', requireCoach, asyncRoute(async (req, res) => {
    if (!['nutrition', 'supplements', 'protocol'].includes(req.params.kind)) throw badRequest('Unknown care plan type.');
    await assertClientAccessById(req, await store.carePlanClientId(req.params.kind, req.params.id));
    res.json({ plan: await store.publishCarePlan(req.params.kind, req.params.id) });
  }));

  router.get('/admin/clients/:clientId/messages', requireCoach, requireClientAccess, asyncRoute(async (req, res) => {
    await store.markMessagesRead(req.params.clientId, 'coach');
    res.json({ messages: await store.listMessages(req.params.clientId, { limit: 100, before: req.query.before }) });
  }));
  router.post('/admin/clients/:clientId/messages', requireCoach, requireClientAccess, messageLimiter, asyncRoute(async (req, res) => {
    const senderName = req.coachingActor.coach?.name || ownerName;
    const message = await store.createMessage(req.params.clientId, 'coach', senderName, cleanText(req.body?.body, { field: 'Message', max: 2000, required: true }));
    broadcastMessage(message, req.scopedClient.coachId);
    pushService?.notifyMessage({ senderType: 'coach', clientId: message.clientId, coachId: req.scopedClient.coachId }).catch(error => console.error('[coaching] push error:', error.message));
    res.status(201).json({ message });
  }));

  router.get('/dashboard', requireClient, asyncRoute(async (req, res) => {
    const dashboard = await store.getDashboard(req.coachingActor.clientId);
    await store.markMessagesRead(req.coachingActor.clientId, 'client');
    res.json({ dashboard });
  }));
  router.patch('/profile', requireClient, asyncRoute(async (req, res) => {
    if (req.body?.coachingAcknowledged !== true) {
      throw badRequest('Confirm the coaching and medical-use acknowledgement to save your profile.');
    }
    const existing = await store.getClient(req.coachingActor.clientId);
    if (!existing) { const error = new Error('Client not found.'); error.statusCode = 404; throw error; }
    const now = new Date().toISOString();
    const profile = cleanProfile({
      ...existing.profile,
      ...(req.body?.profile || {}),
      onboardingCompletedAt: existing.profile?.onboardingCompletedAt || now,
      coachingAcknowledgedAt: existing.profile?.coachingAcknowledgedAt || now,
      updatedByClientAt: now
    });
    const client = await store.updateClientProfile(existing.clientId, profile, 'client');
    res.json({ client });
  }));
  router.get('/messages', requireClient, asyncRoute(async (req, res) => {
    await store.markMessagesRead(req.coachingActor.clientId, 'client');
    res.json({ messages: await store.listMessages(req.coachingActor.clientId, { limit: 100, before: req.query.before }) });
  }));
  router.post('/messages', requireClient, messageLimiter, asyncRoute(async (req, res) => {
    const client = req.coachingActor.client;
    const message = await store.createMessage(client.clientId, 'client', `${client.firstName} ${client.lastName}`.trim(), cleanText(req.body?.body, { field: 'Message', max: 2000, required: true }));
    broadcastMessage(message, client.coachId);
    pushService?.notifyMessage({ senderType: 'client', clientId: message.clientId, coachId: client.coachId }).catch(error => console.error('[coaching] push error:', error.message));
    res.status(201).json({ message });
  }));
  router.post('/checkins', requireClient, asyncRoute(async (req, res) => res.status(201).json({ checkin: await store.createCheckin(req.coachingActor.clientId, cleanCheckin(req.body)) })));
  router.post('/workout-days/:workoutDayId/logs', requireClient, asyncRoute(async (req, res) => res.status(201).json({ log: await store.saveWorkoutLog(req.coachingActor.clientId, req.params.workoutDayId, cleanWorkoutLog(req.body)) })));

  router.get('/messages/stream', requireAuth, asyncRoute(async (req, res) => {
    const requestedClientId = req.coachingActor.actorType === 'coach' ? req.query.clientId : req.coachingActor.clientId;
    if (req.coachingActor.actorType === 'coach') {
      if (!requestedClientId) return res.status(400).json({ error: 'clientId is required.' });
      // Opening a stream is a read of that client, so it needs the same check.
      const client = await store.getClient(requestedClientId);
      if (!canAccessClient(req.coachingActor, client)) return res.status(404).json({ error: 'Client not found.' });
    }
    const key = streamKey(req.coachingActor, requestedClientId);
    if (!streams.has(key)) streams.set(key, new Set());
    streams.get(key).add(res);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write(`event: connected\ndata: ${JSON.stringify({ connected: true })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      streams.get(key)?.delete(res);
      if (!streams.get(key)?.size) streams.delete(key);
    });
  }));

  router.post('/push-subscriptions', requireAuth, asyncRoute(async (req, res) => {
    if (!pushService?.configured) {
      const error = new Error('Push notifications are not configured yet.');
      error.statusCode = 503;
      throw error;
    }
    const subscription = cleanPushSubscription(req.body);
    await store.savePushSubscription(req.coachingActor.actorType, req.coachingActor.clientId, subscription, req.coachingActor.coachId);
    res.status(201).json({ saved: true });
  }));

  router.use((error, _req, res, _next) => {
    const status = error.statusCode || (error.code === 'DATABASE_NOT_CONFIGURED' ? 503 : 500);
    if (status >= 500) console.error('[coaching] request failed:', error.message);
    res.status(status).json({
      error: status >= 500 ? 'The coaching portal is temporarily unavailable.' : error.message,
      details: error.details
    });
  });

  return router;
}

module.exports = {
  cleanCheckin,
  cleanExercise,
  cleanNutritionPlan,
  cleanProfile,
  cleanProtocol,
  cleanSupplementPlan,
  cleanWorkoutLog,
  createCoachingRouter
};
