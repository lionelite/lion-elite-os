'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../database');

function notFound(message = 'Record not found.') {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function mapClient(row) {
  if (!row) return null;
  return {
    clientId: row.client_id,
    subscriptionId: row.subscription_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.status,
    profile: row.profile || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapExercise(row) {
  return {
    exerciseId: row.exercise_id,
    name: row.name,
    slug: row.slug,
    muscleGroup: row.muscle_group,
    equipment: row.equipment,
    instructions: row.instructions,
    videoUrl: row.video_url,
    videoKind: row.video_kind,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapWorkoutExercise(row) {
  return {
    workoutExerciseId: row.workout_exercise_id,
    exerciseId: row.exercise_id,
    name: row.name,
    instructions: row.instructions,
    videoUrl: row.video_url,
    videoKind: row.video_kind,
    sets: row.sets || [],
    sortOrder: row.sort_order
  };
}

function mapWorkoutPlan(row) {
  if (!row) return null;
  return {
    planId: row.plan_id,
    clientId: row.client_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    source: row.source,
    startDate: row.start_date,
    endDate: row.end_date,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    days: []
  };
}

function mapNutritionPlan(row) {
  if (!row) return null;
  return {
    nutritionPlanId: row.nutrition_plan_id,
    clientId: row.client_id,
    title: row.title,
    calorieTarget: row.calorie_target,
    proteinGrams: row.protein_grams,
    carbohydrateGrams: row.carbohydrate_grams,
    fatGrams: row.fat_grams,
    guidance: row.guidance,
    meals: row.meals || [],
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSupplementPlan(row) {
  if (!row) return null;
  return {
    supplementPlanId: row.supplement_plan_id,
    clientId: row.client_id,
    title: row.title,
    items: row.items || [],
    notes: row.notes,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapProtocol(row) {
  if (!row) return null;
  return {
    protocolId: row.protocol_id,
    clientId: row.client_id,
    title: row.title,
    clinicianName: row.clinician_name,
    clinicianConfirmed: row.clinician_confirmed,
    items: row.items || [],
    notes: row.notes,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row) {
  return {
    messageId: row.message_id,
    clientId: row.client_id,
    senderType: row.sender_type,
    senderName: row.sender_name,
    body: row.body,
    readAt: row.read_at,
    createdAt: row.created_at
  };
}

function mapCheckin(row) {
  return {
    checkinId: row.checkin_id,
    clientId: row.client_id,
    weightLbs: row.weight_lbs == null ? null : Number(row.weight_lbs),
    sleepHours: row.sleep_hours == null ? null : Number(row.sleep_hours),
    energy: row.energy,
    adherence: row.adherence,
    soreness: row.soreness,
    notes: row.notes,
    createdAt: row.created_at
  };
}

function mapWorkoutLog(row) {
  return {
    workoutLogId: row.workout_log_id,
    clientId: row.client_id,
    workoutDayId: row.workout_day_id,
    status: row.status,
    performance: row.performance || [],
    effort: row.effort,
    feedback: row.feedback,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at
  };
}

class PostgresCoachingStore {
  constructor(database = { query, withTransaction }) {
    this.database = database;
  }

  async audit(clientId, actorType, eventType, data = {}, executor = this.database) {
    await executor.query(
      `INSERT INTO coaching_audit_events (client_id, actor_type, event_type, data)
       VALUES ($1, $2, $3, $4)`,
      [clientId || null, actorType, eventType, data]
    );
  }

  async createClient(input) {
    try {
      const result = await this.database.query(
        `INSERT INTO coaching_clients (subscription_id, email, first_name, last_name, profile)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.subscriptionId || null, input.email, input.firstName, input.lastName || '', input.profile || {}]
      );
      const client = mapClient(result.rows[0]);
      await this.audit(client.clientId, 'coach', 'client.created', { email: client.email });
      return client;
    } catch (error) {
      if (error.code === '23505') throw conflict('A coaching client with that email already exists.');
      throw error;
    }
  }

  async listClients() {
    const result = await this.database.query(
      `SELECT c.*,
              (SELECT count(*)::int FROM coaching_messages m WHERE m.client_id = c.client_id AND m.sender_type = 'client' AND m.read_at IS NULL) AS unread_count,
              (SELECT max(created_at) FROM coaching_messages m WHERE m.client_id = c.client_id) AS last_message_at,
              (SELECT max(created_at) FROM coaching_checkins ci WHERE ci.client_id = c.client_id) AS last_checkin_at
       FROM coaching_clients c
       ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, c.updated_at DESC`
    );
    return result.rows.map(row => ({
      ...mapClient(row),
      unreadCount: row.unread_count || 0,
      lastMessageAt: row.last_message_at,
      lastCheckinAt: row.last_checkin_at
    }));
  }

  async getClient(clientId) {
    const result = await this.database.query('SELECT * FROM coaching_clients WHERE client_id = $1', [clientId]);
    return mapClient(result.rows[0]);
  }

  async updateClient(clientId, input) {
    const result = await this.database.query(
      `UPDATE coaching_clients
       SET first_name = $2, last_name = $3, email = $4, status = $5, profile = $6, updated_at = now()
       WHERE client_id = $1
       RETURNING *`,
      [clientId, input.firstName, input.lastName || '', input.email, input.status || 'active', input.profile || {}]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'coach', 'client.updated', { status: result.rows[0].status });
    return mapClient(result.rows[0]);
  }

  /**
   * Find the client a Stripe subscription belongs to.
   *
   * Billing events identify the customer by subscription id, not by client id,
   * so this is how a payment event reaches the right person.
   */
  async findClientBySubscriptionId(subscriptionId) {
    if (!subscriptionId) return null;
    const result = await this.database.query(
      'SELECT * FROM coaching_clients WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 1',
      [subscriptionId]
    );
    return result.rows[0] ? mapClient(result.rows[0]) : null;
  }

  /**
   * Change only the access status, leaving every other field untouched.
   *
   * updateClient() rewrites name, email, and profile from its input, so using
   * it to flip a status risks blanking a client's details. Billing events know
   * nothing about names, so they must not be able to overwrite them.
   */
  async setClientStatus(clientId, status, reason = 'billing') {
    const result = await this.database.query(
      `UPDATE coaching_clients SET status = $2, updated_at = now()
       WHERE client_id = $1
       RETURNING *`,
      [clientId, status]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'system', 'client.status.changed', { status, reason });
    return mapClient(result.rows[0]);
  }

  async updateClientProfile(clientId, profile, actorType = 'client') {
    const result = await this.database.query(
      `UPDATE coaching_clients
       SET profile = $2, updated_at = now()
       WHERE client_id = $1
       RETURNING *`,
      [clientId, profile || {}]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, actorType, 'client.profile.updated', { onboardingComplete: Boolean(profile?.onboardingCompletedAt) });
    return mapClient(result.rows[0]);
  }

  async createInvite(clientId, tokenHash, expiresAt) {
    const result = await this.database.query(
      `INSERT INTO coaching_invites (client_id, token_hash, expires_at)
       SELECT client_id, $2, $3 FROM coaching_clients WHERE client_id = $1
       RETURNING invite_id, client_id, expires_at, created_at`,
      [clientId, tokenHash, expiresAt]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'coach', 'invite.created', { expiresAt });
    return result.rows[0];
  }

  async redeemInvite(tokenHash) {
    return this.database.withTransaction(async client => {
      const result = await client.query(
        `SELECT i.*, c.*
         FROM coaching_invites i
         JOIN coaching_clients c ON c.client_id = i.client_id
         WHERE i.token_hash = $1
         FOR UPDATE`,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row || row.redeemed_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
      await client.query('UPDATE coaching_invites SET redeemed_at = now() WHERE invite_id = $1', [row.invite_id]);
      await this.audit(row.client_id, 'client', 'invite.redeemed', { inviteId: row.invite_id }, client);
      return mapClient(row);
    });
  }

  async createSession(tokenHash, actorType, clientId, expiresAt) {
    await this.database.query(
      `INSERT INTO coaching_sessions (session_token_hash, actor_type, client_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, actorType, clientId || null, expiresAt]
    );
    await this.audit(clientId, actorType, 'session.created', { expiresAt });
  }

  async getSession(tokenHash) {
    if (!tokenHash) return null;
    const result = await this.database.query(
      `SELECT s.*, c.email, c.first_name, c.last_name, c.status, c.profile, c.created_at AS client_created_at, c.updated_at AS client_updated_at
       FROM coaching_sessions s
       LEFT JOIN coaching_clients c ON c.client_id = s.client_id
       WHERE s.session_token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.actor_type === 'client' && row.status === 'archived') return null;
    await this.database.query('UPDATE coaching_sessions SET last_seen_at = now() WHERE session_token_hash = $1', [tokenHash]);
    const actor = { actorType: row.actor_type, clientId: row.client_id, expiresAt: row.expires_at };
    if (row.actor_type === 'client') {
      actor.client = mapClient({
        client_id: row.client_id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        status: row.status,
        profile: row.profile,
        created_at: row.client_created_at,
        updated_at: row.client_updated_at
      });
    }
    return actor;
  }

  async deleteSession(tokenHash, actor) {
    await this.database.query('DELETE FROM coaching_sessions WHERE session_token_hash = $1', [tokenHash]);
    if (actor) await this.audit(actor.clientId, actor.actorType, 'session.ended');
  }

  async listExercises() {
    const result = await this.database.query(
      'SELECT * FROM coaching_exercises WHERE active = true ORDER BY muscle_group, name'
    );
    return result.rows.map(mapExercise);
  }

  async createExercise(input) {
    try {
      const result = await this.database.query(
        `INSERT INTO coaching_exercises (name, slug, muscle_group, equipment, instructions, video_url, video_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [input.name, input.slug, input.muscleGroup, input.equipment, input.instructions, input.videoUrl, input.videoKind]
      );
      await this.audit(null, 'coach', 'exercise.created', { exerciseId: result.rows[0].exercise_id });
      return mapExercise(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw conflict('An exercise with that slug already exists.');
      throw error;
    }
  }

  async createWorkoutPlan(clientId, plan, source = 'manual') {
    return this.database.withTransaction(async client => {
      const planResult = await client.query(
        `INSERT INTO coaching_workout_plans (client_id, title, summary, source, start_date, end_date)
         SELECT client_id, $2, $3, $4, $5, $6 FROM coaching_clients WHERE client_id = $1
         RETURNING *`,
        [clientId, plan.title, plan.summary || '', source, plan.startDate || null, plan.endDate || null]
      );
      if (!planResult.rows[0]) throw notFound('Client not found.');
      const created = mapWorkoutPlan(planResult.rows[0]);

      for (const day of plan.days) {
        const dayResult = await client.query(
          `INSERT INTO coaching_workout_days (plan_id, day_index, title, instructions)
           VALUES ($1, $2, $3, $4)
           RETURNING workout_day_id`,
          [created.planId, day.dayIndex, day.title, day.instructions || '']
        );
        for (const exercise of day.exercises) {
          await client.query(
            `INSERT INTO coaching_workout_exercises
             (workout_day_id, exercise_id, name, instructions, video_url, video_kind, sets, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              dayResult.rows[0].workout_day_id,
              exercise.exerciseId || null,
              exercise.name,
              exercise.instructions || '',
              exercise.videoUrl,
              exercise.videoKind,
              exercise.sets || [],
              exercise.sortOrder || 0
            ]
          );
        }
      }
      await this.audit(clientId, 'coach', 'workout_plan.created', { planId: created.planId, source }, client);
      return this.getWorkoutPlan(created.planId, client);
    });
  }

  async getWorkoutPlan(planId, executor = this.database) {
    const planResult = await executor.query('SELECT * FROM coaching_workout_plans WHERE plan_id = $1', [planId]);
    const plan = mapWorkoutPlan(planResult.rows[0]);
    if (!plan) return null;
    const dayResult = await executor.query(
      'SELECT * FROM coaching_workout_days WHERE plan_id = $1 ORDER BY day_index',
      [planId]
    );
    const exerciseResult = await executor.query(
      `SELECT we.* FROM coaching_workout_exercises we
       JOIN coaching_workout_days wd ON wd.workout_day_id = we.workout_day_id
       WHERE wd.plan_id = $1
       ORDER BY wd.day_index, we.sort_order`,
      [planId]
    );
    const exercisesByDay = new Map();
    for (const row of exerciseResult.rows) {
      if (!exercisesByDay.has(row.workout_day_id)) exercisesByDay.set(row.workout_day_id, []);
      exercisesByDay.get(row.workout_day_id).push(mapWorkoutExercise(row));
    }
    plan.days = dayResult.rows.map(row => ({
      workoutDayId: row.workout_day_id,
      dayIndex: row.day_index,
      title: row.title,
      instructions: row.instructions,
      exercises: exercisesByDay.get(row.workout_day_id) || []
    }));
    return plan;
  }

  async listWorkoutPlans(clientId, { publishedOnly = false } = {}) {
    const result = await this.database.query(
      `SELECT plan_id FROM coaching_workout_plans
       WHERE client_id = $1 ${publishedOnly ? "AND status = 'published'" : ''}
       ORDER BY COALESCE(published_at, updated_at) DESC`,
      [clientId]
    );
    return Promise.all(result.rows.map(row => this.getWorkoutPlan(row.plan_id)));
  }

  async publishWorkoutPlan(planId) {
    return this.database.withTransaction(async client => {
      const plan = await this.getWorkoutPlan(planId, client);
      if (!plan) throw notFound('Workout plan not found.');
      const missingVideo = plan.days.flatMap(day => day.exercises).find(exercise => !exercise.videoUrl);
      if (missingVideo) throw conflict(`Add a video before publishing ${missingVideo.name}.`);
      await client.query(
        `UPDATE coaching_workout_plans SET status = 'archived', updated_at = now()
         WHERE client_id = $1 AND status = 'published' AND plan_id <> $2`,
        [plan.clientId, planId]
      );
      await client.query(
        `UPDATE coaching_workout_plans SET status = 'published', published_at = now(), updated_at = now()
         WHERE plan_id = $1`,
        [planId]
      );
      await this.audit(plan.clientId, 'coach', 'workout_plan.published', { planId }, client);
      return this.getWorkoutPlan(planId, client);
    });
  }

  async saveWorkoutLog(clientId, workoutDayId, input) {
    const ownership = await this.database.query(
      `SELECT wd.workout_day_id
       FROM coaching_workout_days wd
       JOIN coaching_workout_plans wp ON wp.plan_id = wd.plan_id
       WHERE wd.workout_day_id = $1 AND wp.client_id = $2 AND wp.status = 'published'`,
      [workoutDayId, clientId]
    );
    if (!ownership.rows[0]) throw notFound('Assigned workout not found.');
    const completedAt = input.status === 'completed' ? new Date() : null;
    const result = await this.database.query(
      `INSERT INTO coaching_workout_logs
       (client_id, workout_day_id, status, performance, effort, feedback, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [clientId, workoutDayId, input.status, input.performance || [], input.effort, input.feedback || '', completedAt]
    );
    await this.audit(clientId, 'client', 'workout.logged', { workoutDayId, status: input.status });
    return mapWorkoutLog(result.rows[0]);
  }

  async listWorkoutLogs(clientId, limit = 20) {
    const result = await this.database.query(
      `SELECT * FROM coaching_workout_logs WHERE client_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [clientId, limit]
    );
    return result.rows.map(mapWorkoutLog);
  }

  async createNutritionPlan(clientId, input) {
    const result = await this.database.query(
      `INSERT INTO coaching_nutrition_plans
       (client_id, title, calorie_target, protein_grams, carbohydrate_grams, fat_grams, guidance, meals)
       SELECT client_id, $2, $3, $4, $5, $6, $7, $8 FROM coaching_clients WHERE client_id = $1
       RETURNING *`,
      [clientId, input.title, input.calorieTarget, input.proteinGrams, input.carbohydrateGrams, input.fatGrams, input.guidance, input.meals]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'coach', 'nutrition_plan.created', { nutritionPlanId: result.rows[0].nutrition_plan_id });
    return mapNutritionPlan(result.rows[0]);
  }

  async createSupplementPlan(clientId, input) {
    const result = await this.database.query(
      `INSERT INTO coaching_supplement_plans (client_id, title, items, notes)
       SELECT client_id, $2, $3, $4 FROM coaching_clients WHERE client_id = $1
       RETURNING *`,
      [clientId, input.title, input.items, input.notes]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'coach', 'supplement_plan.created', { supplementPlanId: result.rows[0].supplement_plan_id });
    return mapSupplementPlan(result.rows[0]);
  }

  async createProtocol(clientId, input) {
    const result = await this.database.query(
      `INSERT INTO coaching_peptide_protocols
       (client_id, title, clinician_name, clinician_confirmed, items, notes)
       SELECT client_id, $2, $3, $4, $5, $6 FROM coaching_clients WHERE client_id = $1
       RETURNING *`,
      [clientId, input.title, input.clinicianName, input.clinicianConfirmed, input.items, input.notes]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'coach', 'protocol.created', { protocolId: result.rows[0].protocol_id, clinicianConfirmed: input.clinicianConfirmed });
    return mapProtocol(result.rows[0]);
  }

  async publishCarePlan(kind, id) {
    const config = {
      nutrition: { table: 'coaching_nutrition_plans', id: 'nutrition_plan_id', map: mapNutritionPlan },
      supplements: { table: 'coaching_supplement_plans', id: 'supplement_plan_id', map: mapSupplementPlan },
      protocol: { table: 'coaching_peptide_protocols', id: 'protocol_id', map: mapProtocol }
    }[kind];
    if (!config) throw new Error('Unknown care plan kind.');
    return this.database.withTransaction(async client => {
      const result = await client.query(`SELECT * FROM ${config.table} WHERE ${config.id} = $1 FOR UPDATE`, [id]);
      const row = result.rows[0];
      if (!row) throw notFound('Plan not found.');
      if (kind === 'protocol' && !row.clinician_confirmed) {
        const error = conflict('A peptide protocol must be confirmed by a licensed clinician before it can be published.');
        error.statusCode = 422;
        throw error;
      }
      await client.query(
        `UPDATE ${config.table} SET status = 'archived', updated_at = now()
         WHERE client_id = $1 AND status = 'published' AND ${config.id} <> $2`,
        [row.client_id, id]
      );
      const published = await client.query(
        `UPDATE ${config.table} SET status = 'published', published_at = now(), updated_at = now()
         WHERE ${config.id} = $1 RETURNING *`,
        [id]
      );
      await this.audit(row.client_id, 'coach', `${kind}.published`, { id }, client);
      return config.map(published.rows[0]);
    });
  }

  async latestCarePlan(clientId, kind, publishedOnly = true) {
    const config = {
      nutrition: { table: 'coaching_nutrition_plans', map: mapNutritionPlan },
      supplements: { table: 'coaching_supplement_plans', map: mapSupplementPlan },
      protocol: { table: 'coaching_peptide_protocols', map: mapProtocol }
    }[kind];
    const result = await this.database.query(
      `SELECT * FROM ${config.table}
       WHERE client_id = $1 ${publishedOnly ? "AND status = 'published'" : ''}
       ORDER BY COALESCE(published_at, updated_at) DESC LIMIT 1`,
      [clientId]
    );
    return config.map(result.rows[0]);
  }

  async listMessages(clientId, { limit = 100, before } = {}) {
    const params = [clientId, limit];
    const beforeClause = before ? 'AND created_at < $3' : '';
    if (before) params.push(before);
    const result = await this.database.query(
      `SELECT * FROM (
         SELECT * FROM coaching_messages
         WHERE client_id = $1 ${beforeClause}
         ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      params
    );
    return result.rows.map(mapMessage);
  }

  async createMessage(clientId, senderType, senderName, body) {
    const result = await this.database.query(
      `INSERT INTO coaching_messages (client_id, sender_type, sender_name, body)
       SELECT client_id, $2, $3, $4 FROM coaching_clients WHERE client_id = $1
       RETURNING *`,
      [clientId, senderType, senderName, body]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, senderType, 'message.sent', { messageId: result.rows[0].message_id });
    return mapMessage(result.rows[0]);
  }

  async markMessagesRead(clientId, readerType) {
    await this.database.query(
      `UPDATE coaching_messages SET read_at = now()
       WHERE client_id = $1 AND sender_type <> $2 AND read_at IS NULL`,
      [clientId, readerType]
    );
  }

  async createCheckin(clientId, input) {
    const result = await this.database.query(
      `INSERT INTO coaching_checkins
       (client_id, weight_lbs, sleep_hours, energy, adherence, soreness, notes)
       SELECT client_id, $2, $3, $4, $5, $6, $7 FROM coaching_clients WHERE client_id = $1
       RETURNING *`,
      [clientId, input.weightLbs, input.sleepHours, input.energy, input.adherence, input.soreness, input.notes]
    );
    if (!result.rows[0]) throw notFound('Client not found.');
    await this.audit(clientId, 'client', 'checkin.created', { checkinId: result.rows[0].checkin_id });
    return mapCheckin(result.rows[0]);
  }

  async listCheckins(clientId, limit = 20) {
    const result = await this.database.query(
      'SELECT * FROM coaching_checkins WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2',
      [clientId, limit]
    );
    return result.rows.map(mapCheckin);
  }

  async savePushSubscription(actorType, clientId, subscription) {
    const result = await this.database.query(
      `INSERT INTO coaching_push_subscriptions (actor_type, client_id, endpoint, subscription)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
       SET actor_type = EXCLUDED.actor_type, client_id = EXCLUDED.client_id,
           subscription = EXCLUDED.subscription, updated_at = now()
       RETURNING push_subscription_id`,
      [actorType, clientId || null, subscription.endpoint, subscription]
    );
    return result.rows[0];
  }

  async listPushSubscriptions(actorType, clientId = null) {
    const result = await this.database.query(
      `SELECT subscription FROM coaching_push_subscriptions
       WHERE actor_type = $1 AND (($2::uuid IS NULL AND client_id IS NULL) OR client_id = $2::uuid)`,
      [actorType, clientId]
    );
    return result.rows.map(row => row.subscription);
  }

  async removePushSubscription(endpoint) {
    await this.database.query('DELETE FROM coaching_push_subscriptions WHERE endpoint = $1', [endpoint]);
  }

  async getDashboard(clientId) {
    const client = await this.getClient(clientId);
    if (!client) throw notFound('Client not found.');
    const [workouts, nutrition, supplements, protocol, messages, checkins, workoutLogs] = await Promise.all([
      this.listWorkoutPlans(clientId, { publishedOnly: true }),
      this.latestCarePlan(clientId, 'nutrition'),
      this.latestCarePlan(clientId, 'supplements'),
      this.latestCarePlan(clientId, 'protocol'),
      this.listMessages(clientId, { limit: 30 }),
      this.listCheckins(clientId, 12),
      this.listWorkoutLogs(clientId, 20)
    ]);
    return { client, workoutPlan: workouts[0] || null, nutrition, supplements, protocol, messages, checkins, workoutLogs };
  }
}

class MemoryCoachingStore {
  constructor() {
    this.clients = new Map();
    this.invites = new Map();
    this.sessions = new Map();
    this.exercises = new Map();
    this.workoutPlans = new Map();
    this.nutritionPlans = new Map();
    this.supplementPlans = new Map();
    this.protocols = new Map();
    this.messages = [];
    this.checkins = [];
    this.workoutLogs = [];
    this.pushSubscriptions = [];
    this.auditEvents = [];
  }

  id() { return crypto.randomUUID(); }
  now() { return new Date().toISOString(); }
  async audit(clientId, actorType, eventType, data = {}) {
    this.auditEvents.push({ auditEventId: this.id(), clientId, actorType, eventType, data, createdAt: this.now() });
  }

  async createClient(input) {
    if ([...this.clients.values()].some(client => client.email === input.email)) throw conflict('A coaching client with that email already exists.');
    const now = this.now();
    const client = { clientId: this.id(), subscriptionId: input.subscriptionId || null, email: input.email, firstName: input.firstName, lastName: input.lastName || '', status: 'active', profile: input.profile || {}, createdAt: now, updatedAt: now };
    this.clients.set(client.clientId, client);
    await this.audit(client.clientId, 'coach', 'client.created', { email: client.email });
    return structuredClone(client);
  }

  async listClients() {
    return [...this.clients.values()].map(client => ({
      ...structuredClone(client),
      unreadCount: this.messages.filter(message => message.clientId === client.clientId && message.senderType === 'client' && !message.readAt).length,
      lastMessageAt: this.messages.filter(message => message.clientId === client.clientId).at(-1)?.createdAt || null,
      lastCheckinAt: this.checkins.filter(checkin => checkin.clientId === client.clientId).at(-1)?.createdAt || null
    }));
  }

  async getClient(clientId) { return this.clients.has(clientId) ? structuredClone(this.clients.get(clientId)) : null; }
  async updateClient(clientId, input) {
    const current = this.clients.get(clientId);
    if (!current) throw notFound('Client not found.');
    const updated = { ...current, ...structuredClone(input), clientId, updatedAt: this.now() };
    this.clients.set(clientId, updated);
    await this.audit(clientId, 'coach', 'client.updated', { status: updated.status });
    return structuredClone(updated);
  }

  async findClientBySubscriptionId(subscriptionId) {
    if (!subscriptionId) return null;
    const match = [...this.clients.values()].find(client => client.subscriptionId === subscriptionId);
    return match ? structuredClone(match) : null;
  }

  async setClientStatus(clientId, status, reason = 'billing') {
    const current = this.clients.get(clientId);
    if (!current) throw notFound('Client not found.');
    const updated = { ...current, status, updatedAt: this.now() };
    this.clients.set(clientId, updated);
    await this.audit(clientId, 'system', 'client.status.changed', { status, reason });
    return structuredClone(updated);
  }

  async updateClientProfile(clientId, profile, actorType = 'client') {
    const current = this.clients.get(clientId);
    if (!current) throw notFound('Client not found.');
    const updated = { ...current, profile: structuredClone(profile || {}), updatedAt: this.now() };
    this.clients.set(clientId, updated);
    await this.audit(clientId, actorType, 'client.profile.updated', { onboardingComplete: Boolean(profile?.onboardingCompletedAt) });
    return structuredClone(updated);
  }

  async createInvite(clientId, tokenHash, expiresAt) {
    if (!this.clients.has(clientId)) throw notFound('Client not found.');
    const invite = { inviteId: this.id(), clientId, tokenHash, expiresAt: new Date(expiresAt).toISOString(), redeemedAt: null, createdAt: this.now() };
    this.invites.set(tokenHash, invite);
    await this.audit(clientId, 'coach', 'invite.created', { expiresAt });
    return structuredClone(invite);
  }

  async redeemInvite(tokenHash) {
    const invite = this.invites.get(tokenHash);
    if (!invite || invite.redeemedAt || new Date(invite.expiresAt).getTime() <= Date.now()) return null;
    invite.redeemedAt = this.now();
    await this.audit(invite.clientId, 'client', 'invite.redeemed', { inviteId: invite.inviteId });
    return this.getClient(invite.clientId);
  }

  async createSession(tokenHash, actorType, clientId, expiresAt) {
    this.sessions.set(tokenHash, { actorType, clientId: clientId || null, expiresAt: new Date(expiresAt).toISOString() });
  }

  async getSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null;
    const result = structuredClone(session);
    if (result.actorType === 'client') {
      result.client = await this.getClient(result.clientId);
      if (!result.client || result.client.status === 'archived') return null;
    }
    return result;
  }

  async deleteSession(tokenHash) { this.sessions.delete(tokenHash); }

  async listExercises() { return [...this.exercises.values()].filter(item => item.active).map(item => structuredClone(item)); }
  async createExercise(input) {
    if ([...this.exercises.values()].some(item => item.slug === input.slug)) throw conflict('An exercise with that slug already exists.');
    const now = this.now();
    const exercise = { exerciseId: this.id(), ...structuredClone(input), active: true, createdAt: now, updatedAt: now };
    this.exercises.set(exercise.exerciseId, exercise);
    return structuredClone(exercise);
  }

  async createWorkoutPlan(clientId, plan, source = 'manual') {
    if (!this.clients.has(clientId)) throw notFound('Client not found.');
    const now = this.now();
    const created = {
      planId: this.id(), clientId, title: plan.title, summary: plan.summary || '', status: 'draft', source,
      startDate: plan.startDate || null, endDate: plan.endDate || null, publishedAt: null, createdAt: now, updatedAt: now,
      days: plan.days.map(day => ({
        ...structuredClone(day), workoutDayId: this.id(),
        exercises: day.exercises.map(exercise => ({ ...structuredClone(exercise), workoutExerciseId: this.id() }))
      }))
    };
    this.workoutPlans.set(created.planId, created);
    await this.audit(clientId, 'coach', 'workout_plan.created', { planId: created.planId, source });
    return structuredClone(created);
  }

  async getWorkoutPlan(planId) { return this.workoutPlans.has(planId) ? structuredClone(this.workoutPlans.get(planId)) : null; }
  async listWorkoutPlans(clientId, { publishedOnly = false } = {}) {
    return [...this.workoutPlans.values()].filter(plan => plan.clientId === clientId && (!publishedOnly || plan.status === 'published')).map(plan => structuredClone(plan)).reverse();
  }
  async publishWorkoutPlan(planId) {
    const plan = this.workoutPlans.get(planId);
    if (!plan) throw notFound('Workout plan not found.');
    for (const current of this.workoutPlans.values()) if (current.clientId === plan.clientId && current.status === 'published') current.status = 'archived';
    plan.status = 'published'; plan.publishedAt = this.now(); plan.updatedAt = this.now();
    await this.audit(plan.clientId, 'coach', 'workout_plan.published', { planId });
    return structuredClone(plan);
  }

  async saveWorkoutLog(clientId, workoutDayId, input) {
    const ownsDay = [...this.workoutPlans.values()].some(plan => plan.clientId === clientId && plan.status === 'published' && plan.days.some(day => day.workoutDayId === workoutDayId));
    if (!ownsDay) throw notFound('Assigned workout not found.');
    const now = this.now();
    const log = { workoutLogId: this.id(), clientId, workoutDayId, ...structuredClone(input), startedAt: now, completedAt: input.status === 'completed' ? now : null, updatedAt: now };
    this.workoutLogs.push(log);
    await this.audit(clientId, 'client', 'workout.logged', { workoutDayId, status: input.status });
    return structuredClone(log);
  }
  async listWorkoutLogs(clientId, limit = 20) { return this.workoutLogs.filter(log => log.clientId === clientId).slice(-limit).reverse().map(log => structuredClone(log)); }

  async createNutritionPlan(clientId, input) { return this.createMemoryCarePlan(this.nutritionPlans, 'nutritionPlanId', clientId, input, 'nutrition_plan.created'); }
  async createSupplementPlan(clientId, input) { return this.createMemoryCarePlan(this.supplementPlans, 'supplementPlanId', clientId, input, 'supplement_plan.created'); }
  async createProtocol(clientId, input) { return this.createMemoryCarePlan(this.protocols, 'protocolId', clientId, input, 'protocol.created'); }
  async createMemoryCarePlan(map, idField, clientId, input, eventType) {
    if (!this.clients.has(clientId)) throw notFound('Client not found.');
    const now = this.now();
    const item = { [idField]: this.id(), clientId, ...structuredClone(input), status: 'draft', publishedAt: null, createdAt: now, updatedAt: now };
    map.set(item[idField], item);
    await this.audit(clientId, 'coach', eventType, { [idField]: item[idField] });
    return structuredClone(item);
  }
  async publishCarePlan(kind, id) {
    const map = kind === 'nutrition' ? this.nutritionPlans : kind === 'supplements' ? this.supplementPlans : this.protocols;
    const item = map.get(id);
    if (!item) throw notFound('Plan not found.');
    if (kind === 'protocol' && !item.clinicianConfirmed) {
      const error = conflict('A peptide protocol must be confirmed by a licensed clinician before it can be published.');
      error.statusCode = 422; throw error;
    }
    for (const current of map.values()) if (current.clientId === item.clientId && current.status === 'published') current.status = 'archived';
    item.status = 'published'; item.publishedAt = this.now(); item.updatedAt = this.now();
    await this.audit(item.clientId, 'coach', `${kind}.published`, { id });
    return structuredClone(item);
  }
  async latestCarePlan(clientId, kind, publishedOnly = true) {
    const map = kind === 'nutrition' ? this.nutritionPlans : kind === 'supplements' ? this.supplementPlans : this.protocols;
    return [...map.values()].filter(item => item.clientId === clientId && (!publishedOnly || item.status === 'published')).map(item => structuredClone(item)).at(-1) || null;
  }

  async listMessages(clientId, { limit = 100, before } = {}) {
    return this.messages.filter(message => message.clientId === clientId && (!before || message.createdAt < before)).slice(-limit).map(message => structuredClone(message));
  }
  async createMessage(clientId, senderType, senderName, body) {
    if (!this.clients.has(clientId)) throw notFound('Client not found.');
    const message = { messageId: this.id(), clientId, senderType, senderName, body, readAt: null, createdAt: this.now() };
    this.messages.push(message); await this.audit(clientId, senderType, 'message.sent', { messageId: message.messageId }); return structuredClone(message);
  }
  async markMessagesRead(clientId, readerType) { for (const message of this.messages) if (message.clientId === clientId && message.senderType !== readerType) message.readAt ||= this.now(); }
  async createCheckin(clientId, input) {
    if (!this.clients.has(clientId)) throw notFound('Client not found.');
    const checkin = { checkinId: this.id(), clientId, ...structuredClone(input), createdAt: this.now() };
    this.checkins.push(checkin); await this.audit(clientId, 'client', 'checkin.created', { checkinId: checkin.checkinId }); return structuredClone(checkin);
  }
  async listCheckins(clientId, limit = 20) { return this.checkins.filter(checkin => checkin.clientId === clientId).slice(-limit).reverse().map(checkin => structuredClone(checkin)); }
  async savePushSubscription(actorType, clientId, subscription) {
    this.pushSubscriptions = this.pushSubscriptions.filter(item => item.subscription.endpoint !== subscription.endpoint);
    this.pushSubscriptions.push({ actorType, clientId: clientId || null, subscription: structuredClone(subscription) }); return { ok: true };
  }
  async listPushSubscriptions(actorType, clientId = null) { return this.pushSubscriptions.filter(item => item.actorType === actorType && item.clientId === clientId).map(item => structuredClone(item.subscription)); }
  async removePushSubscription(endpoint) { this.pushSubscriptions = this.pushSubscriptions.filter(item => item.subscription.endpoint !== endpoint); }
  async getDashboard(clientId) {
    const client = await this.getClient(clientId); if (!client) throw notFound('Client not found.');
    const workouts = await this.listWorkoutPlans(clientId, { publishedOnly: true });
    return {
      client, workoutPlan: workouts[0] || null,
      nutrition: await this.latestCarePlan(clientId, 'nutrition'), supplements: await this.latestCarePlan(clientId, 'supplements'), protocol: await this.latestCarePlan(clientId, 'protocol'),
      messages: await this.listMessages(clientId, { limit: 30 }), checkins: await this.listCheckins(clientId, 12), workoutLogs: await this.listWorkoutLogs(clientId, 20)
    };
  }
}

module.exports = {
  MemoryCoachingStore,
  PostgresCoachingStore,
  mapCheckin,
  mapClient,
  mapExercise,
  mapMessage,
  mapNutritionPlan,
  mapProtocol,
  mapSupplementPlan,
  mapWorkoutPlan
};
