'use strict';

const { pool } = require('./db');

function mapRow(row) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listReviewItems({ limit = 10 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
  const result = await pool.query(
    `SELECT q.*, p.business, p.contact, p.score, p.personalization, p.validation, p.stage
     FROM outreach_queue q
     JOIN prospects p ON p.prospect_id = q.prospect_id
     WHERE q.status = 'awaiting_review'
     ORDER BY COALESCE(p.score, 0) DESC, q.created_at ASC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map(row => ({
    ...mapRow(row),
    prospect: {
      business: row.business,
      contact: row.contact,
      score: row.score,
      personalization: row.personalization,
      validation: row.validation,
      stage: row.stage
    }
  }));
}

async function getReviewItem(queueId) {
  const result = await pool.query('SELECT * FROM outreach_queue WHERE queue_id=$1', [queueId]);
  return mapRow(result.rows[0]);
}

async function updateReviewDraft(queueId, { subject, body }) {
  const result = await pool.query(
    `UPDATE outreach_queue
     SET subject=COALESCE($2,subject), body=COALESCE($3,body), updated_at=NOW()
     WHERE queue_id=$1 AND status='awaiting_review'
     RETURNING *`,
    [queueId, subject ?? null, body ?? null]
  );
  return mapRow(result.rows[0]);
}

module.exports = { listReviewItems, getReviewItem, updateReviewDraft };
