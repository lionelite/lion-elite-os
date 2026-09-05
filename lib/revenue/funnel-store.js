'use strict';

/**
 * Postgres persistence for funnel events (Issue #89, P1).
 *
 * Thin on purpose: validation and funnel maths live in funnel-events.js and
 * executive-report.js so they stay testable without a database. This file only
 * moves rows.
 */

const { pool } = require('../db');
const { buildEvent } = require('./funnel-events');

function mapRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    eventKey: row.event_key,
    type: row.type,
    brand: row.brand,
    source: row.source,
    subjectId: row.subject_id,
    subjectHash: row.subject_hash,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    occurredAt: row.occurred_at,
    metadata: row.metadata || {},
  };
}

/**
 * Record one event. Idempotent: replaying the same event_key is a no-op that
 * returns the row already stored, so a retried webhook cannot inflate revenue.
 * Returns { event, duplicate }.
 */
async function record(input) {
  const event = buildEvent(input);

  const { rows } = await pool.query(
    `INSERT INTO funnel_events
       (event_key, type, brand, source, subject_id, subject_hash, amount_cents, occurred_at, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [
      event.eventKey,
      event.type,
      event.brand,
      event.source,
      event.subjectId,
      event.subjectHash,
      event.amountCents,
      event.occurredAt,
      JSON.stringify(event.metadata),
    ]
  );

  if (rows.length > 0) return { event: mapRow(rows[0]), duplicate: false };

  const existing = await pool.query('SELECT * FROM funnel_events WHERE event_key = $1', [event.eventKey]);
  return { event: mapRow(existing.rows[0]), duplicate: true };
}

/** Record many events, continuing past individual validation failures. */
async function recordMany(inputs = []) {
  const recorded = [];
  const rejected = [];
  for (const input of inputs) {
    try {
      recorded.push(await record(input));
    } catch (error) {
      rejected.push({ input, error: error.message, code: error.code });
    }
  }
  return { recorded, rejected };
}

/**
 * Events in a reporting window. `endDate` is exclusive so day boundaries do not
 * double-count an event that lands exactly at midnight.
 */
async function eventsInWindow({ endDate = new Date(), windowDays = 1 } = {}) {
  const end = new Date(endDate);
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    'SELECT * FROM funnel_events WHERE occurred_at >= $1 AND occurred_at < $2 ORDER BY occurred_at ASC',
    [start, end]
  );
  return rows.map(mapRow);
}

/**
 * Has this subject ever completed a purchase before?
 *
 * Used to decide purchase_completed vs repeat_purchase at emit time. Looking it
 * up beats guessing: the two are separate stages in the taxonomy, and repeat
 * revenue is reported on its own line.
 */
async function hasPriorPurchase(subjectId) {
  if (!subjectId) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM funnel_events
      WHERE subject_id = $1 AND type IN ('purchase_completed','repeat_purchase')
      LIMIT 1`,
    [subjectId]
  );
  return rows.length > 0;
}

module.exports = { record, recordMany, eventsInWindow, hasPriorPurchase, mapRow };
