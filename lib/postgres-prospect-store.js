'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('./db');
const { createBusinessFingerprint } = require('./outreach-validation');

const STAGES = Object.freeze([
  'discovered','verification_pending','verified','research_pending','research_complete',
  'qualification_pending','qualified','disqualified','personalization_pending','ready_for_review',
  'approved_for_outreach','queued','sent','engaged','meeting_booked','opportunity','customer','nurture','suppressed'
]);

function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function dateKey(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

function mapProspect(row) {
  if (!row) return null;
  return {
    prospectId: row.prospect_id,
    fingerprint: row.fingerprint,
    business: row.business,
    contact: row.contact,
    campaignId: row.campaign_id,
    ownerId: row.owner_id,
    stage: row.stage,
    status: row.status,
    score: row.score,
    enrichment: row.enrichment,
    personalization: row.personalization,
    validation: row.validation,
    nextAction: row.next_action,
    nextActionAt: row.next_action_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapQueue(row) {
  if (!row) return null;
  return {
    queueId: row.queue_id,
    prospectId: row.prospect_id,
    campaignId: row.campaign_id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    messageVersion: row.message_version,
    validationRunId: row.validation_run_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    scheduledAt: row.scheduled_at,
    attempts: row.attempts,
    providerMessageId: row.metadata?.providerMessageId || null,
    lastError: row.metadata?.lastError || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class PostgresProspectStore {
  constructor() {
    this.dailyEmailLimit = Number(process.env.DAILY_EMAIL_LIMIT || 100);
  }

  async #event(client, prospectId, type, data = {}, actor = 'system') {
    await client.query(
      `INSERT INTO prospect_events (event_id, prospect_id, type, actor, data)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [crypto.randomUUID(), prospectId, type, actor, JSON.stringify(data)]
    );
  }

  async create(input, actor = 'system') {
    const business = input.business || {};
    const fingerprint = createBusinessFingerprint(business);
    return withTransaction(async client => {
      const existing = await client.query('SELECT * FROM prospects WHERE fingerprint = $1', [fingerprint]);
      if (existing.rowCount) return { prospect: mapProspect(existing.rows[0]), duplicate: true };
      const prospectId = id('pro');
      const inserted = await client.query(
        `INSERT INTO prospects (
          prospect_id,fingerprint,business,contact,campaign_id,owner_id,stage,status,
          score,enrichment,personalization,validation,next_action,next_action_at
        ) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,'discovered','active',NULL,NULL,NULL,NULL,'verify_identity',NULL)
        RETURNING *`,
        [prospectId, fingerprint, JSON.stringify(business), JSON.stringify(input.contact || null), input.campaignId || null, input.ownerId || null]
      );
      await this.#event(client, prospectId, 'prospect.created', { campaignId: input.campaignId || null }, actor);
      return { prospect: mapProspect(inserted.rows[0]), duplicate: false };
    });
  }

  async list(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [['stage',filters.stage],['campaign_id',filters.campaignId],['owner_id',filters.ownerId],['status',filters.status]]) {
      if (value) { values.push(value); clauses.push(`${column} = $${values.length}`); }
    }
    const sql = `SELECT * FROM prospects ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC`;
    const result = await pool.query(sql, values);
    return result.rows.map(mapProspect);
  }

  async get(prospectId) {
    const result = await pool.query('SELECT * FROM prospects WHERE prospect_id = $1', [prospectId]);
    return mapProspect(result.rows[0]);
  }

  async update(prospectId, patch, actor = 'system') {
    const allowed = {
      business:'business', contact:'contact', campaignId:'campaign_id', ownerId:'owner_id',
      stage:'stage', status:'status', score:'score', enrichment:'enrichment',
      personalization:'personalization', validation:'validation', nextAction:'next_action', nextActionAt:'next_action_at'
    };
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch || {})) {
      const column = allowed[key];
      if (!column) continue;
      values.push(['business','contact','enrichment','personalization','validation'].includes(key) ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${['business','contact','enrichment','personalization','validation'].includes(key) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return this.get(prospectId);
    values.push(prospectId);
    return withTransaction(async client => {
      const result = await client.query(`UPDATE prospects SET ${sets.join(', ')}, updated_at = NOW() WHERE prospect_id = $${values.length} RETURNING *`, values);
      if (!result.rowCount) return null;
      await this.#event(client, prospectId, 'prospect.updated', { fields: Object.keys(patch || {}) }, actor);
      return mapProspect(result.rows[0]);
    });
  }

  async transition(prospectId, stage, metadata = {}, actor = 'system') {
    if (!STAGES.includes(stage)) throw Object.assign(new Error('Invalid prospect stage.'), { code: 'INVALID_STAGE' });
    return withTransaction(async client => {
      const current = await client.query('SELECT stage FROM prospects WHERE prospect_id = $1 FOR UPDATE', [prospectId]);
      if (!current.rowCount) return null;
      const from = current.rows[0].stage;
      const status = stage === 'suppressed' ? 'suppressed' : null;
      const result = await client.query(
        `UPDATE prospects SET stage=$2, status=COALESCE($3,status), updated_at=NOW() WHERE prospect_id=$1 RETURNING *`,
        [prospectId, stage, status]
      );
      await this.#event(client, prospectId, 'prospect.stage_changed', { from, to: stage, ...metadata }, actor);
      return mapProspect(result.rows[0]);
    });
  }

  async enqueue(prospectId, authorization, message, scheduledAt = new Date().toISOString(), actor = 'system') {
    if (!authorization?.authorized || !authorization?.idempotencyKey) throw Object.assign(new Error('Valid outreach authorization required.'), { code: 'AUTHORIZATION_REQUIRED' });
    return withTransaction(async client => {
      const prospectResult = await client.query('SELECT * FROM prospects WHERE prospect_id=$1 FOR UPDATE', [prospectId]);
      if (!prospectResult.rowCount) throw Object.assign(new Error('Prospect not found.'), { code: 'PROSPECT_NOT_FOUND' });
      const prospect = prospectResult.rows[0];
      if (prospect.status === 'suppressed') throw Object.assign(new Error('Suppressed prospect cannot be queued.'), { code: 'PROSPECT_SUPPRESSED' });
      const existing = await client.query('SELECT * FROM outreach_queue WHERE idempotency_key=$1', [authorization.idempotencyKey]);
      if (existing.rowCount) return { item: mapQueue(existing.rows[0]), duplicate: true };
      const queueId = id('que');
      const inserted = await client.query(
        `INSERT INTO outreach_queue (
          queue_id,prospect_id,campaign_id,channel,recipient,subject,body,message_version,
          validation_run_id,idempotency_key,status,scheduled_at,attempts
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,0) RETURNING *`,
        [queueId, prospectId, prospect.campaign_id, message.channel || 'email', message.recipient, message.subject || null, message.body, message.messageVersion || null, authorization.validationRunId || null, authorization.idempotencyKey, scheduledAt]
      );
      await client.query("UPDATE prospects SET stage='queued',updated_at=NOW() WHERE prospect_id=$1", [prospectId]);
      await this.#event(client, prospectId, 'outreach.queued', { queueId, channel: message.channel || 'email' }, actor);
      return { item: mapQueue(inserted.rows[0]), duplicate: false };
    });
  }

  async listQueue(filters = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [['status',filters.status],['campaign_id',filters.campaignId],['prospect_id',filters.prospectId]]) {
      if (value) { values.push(value); clauses.push(`${column} = $${values.length}`); }
    }
    const result = await pool.query(`SELECT * FROM outreach_queue ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY scheduled_at ASC`, values);
    return result.rows.map(mapQueue);
  }

  async getDailyEmailQuota(day = dateKey()) {
    const result = await pool.query("SELECT sent_count FROM daily_usage WHERE usage_day=$1 AND channel='email'", [day]);
    const sent = Number(result.rows[0]?.sent_count || 0);
    return { day, limit: this.dailyEmailLimit, sent, remaining: Math.max(0, this.dailyEmailLimit - sent), exhausted: sent >= this.dailyEmailLimit };
  }

  async markQueue(queueId, status, metadata = {}, actor = 'system') {
    return withTransaction(async client => {
      const current = await client.query('SELECT * FROM outreach_queue WHERE queue_id=$1 FOR UPDATE', [queueId]);
      if (!current.rowCount) return null;
      const item = current.rows[0];
      if (status === 'processing' && item.channel === 'email') {
        const usage = await client.query("SELECT sent_count FROM daily_usage WHERE usage_day=CURRENT_DATE AND channel='email' FOR UPDATE");
        const sent = Number(usage.rows[0]?.sent_count || 0);
        if (sent >= this.dailyEmailLimit) throw Object.assign(new Error(`Daily email quota of ${this.dailyEmailLimit} has been reached.`), { code: 'DAILY_EMAIL_QUOTA_REACHED' });
      }
      if (status === 'sent' && item.channel === 'email' && item.status !== 'sent') {
        const usage = await client.query(
          `INSERT INTO daily_usage (usage_day,channel,sent_count) VALUES (CURRENT_DATE,'email',1)
           ON CONFLICT (usage_day,channel) DO UPDATE SET sent_count=daily_usage.sent_count+1
           WHERE daily_usage.sent_count < $1 RETURNING sent_count`,
          [this.dailyEmailLimit]
        );
        if (!usage.rowCount) throw Object.assign(new Error(`Daily email quota of ${this.dailyEmailLimit} has been reached.`), { code: 'DAILY_EMAIL_QUOTA_REACHED' });
      }
      const attemptsIncrement = status === 'processing' ? 1 : 0;
      const nextMetadata = { ...(item.metadata || {}), ...metadata };
      const result = await client.query(
        `UPDATE outreach_queue SET status=$2, attempts=attempts+$3, metadata=$4::jsonb,
         updated_at=NOW() WHERE queue_id=$1 RETURNING *`,
        [queueId, status, attemptsIncrement, JSON.stringify(nextMetadata)]
      );
      const stageMap = { sent:'sent', replied:'engaged', meeting_booked:'meeting_booked', suppressed:'suppressed' };
      if (stageMap[status]) await client.query('UPDATE prospects SET stage=$2,status=CASE WHEN $2=\'suppressed\' THEN \'suppressed\' ELSE status END,updated_at=NOW() WHERE prospect_id=$1', [item.prospect_id, stageMap[status]]);
      await this.#event(client, item.prospect_id, `outreach.${status}`, { queueId, ...metadata }, actor);
      return mapQueue(result.rows[0]);
    });
  }

  async timeline(prospectId) {
    const result = await pool.query('SELECT * FROM prospect_events WHERE prospect_id=$1 ORDER BY created_at ASC', [prospectId]);
    return result.rows.map(row => ({ eventId: row.event_id, prospectId: row.prospect_id, type: row.type, actor: row.actor, data: row.data, createdAt: row.created_at }));
  }

  async metrics() {
    const [prospects, stages, queue, events, quota] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM prospects'),
      pool.query('SELECT stage,COUNT(*)::int AS count FROM prospects GROUP BY stage'),
      pool.query('SELECT status,COUNT(*)::int AS count FROM outreach_queue GROUP BY status'),
      pool.query('SELECT COUNT(*)::int AS count FROM prospect_events'),
      this.getDailyEmailQuota()
    ]);
    return {
      prospects: prospects.rows[0].count,
      byStage: Object.fromEntries(stages.rows.map(r => [r.stage, r.count])),
      queue: Object.fromEntries(queue.rows.map(r => [r.status, r.count])),
      events: events.rows[0].count,
      emailQuota: quota
    };
  }
}

module.exports = { PostgresProspectStore, STAGES };
