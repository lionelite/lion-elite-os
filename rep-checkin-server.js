'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.REP_PORTAL_PORT || process.env.PORT || 10020);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
const repToken = process.env.REP_PORTAL_TOKEN || '';
const managerToken = process.env.REP_MANAGER_TOKEN || '';

app.use(express.json({ limit: '128kb' }));
app.use('/rep-portal', express.static(path.join(__dirname, 'public', 'rep-portal')));

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function tokenMatches(value, expected) {
  if (!expected || !value || value.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function requireRep(req, res, next) {
  if (!repToken || tokenMatches(bearer(req), repToken) || tokenMatches(bearer(req), managerToken)) return next();
  return res.status(401).json({ error: 'UNAUTHORIZED' });
}

function requireManager(req, res, next) {
  if (!managerToken || tokenMatches(bearer(req), managerToken)) return next();
  return res.status(401).json({ error: 'MANAGER_UNAUTHORIZED' });
}

function nonnegative(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function performanceScore(input) {
  const activity = Math.min(30, nonnegative(input.leadsContacted) * 0.25 + nonnegative(input.followupsCompleted) * 0.35);
  const pipeline = Math.min(30, nonnegative(input.conversationsStarted) * 1.5 + nonnegative(input.consultationsBooked) * 4);
  const results = Math.min(30, nonnegative(input.salesClosed) * 8 + nonnegative(input.revenueCents) / 50000);
  const confidence = clamp(nonnegative(input.confidenceScore), 1, 10);
  return clamp(Math.round(activity + pipeline + results + confidence), 0, 100);
}

function normalizeCheckin(body = {}) {
  const repId = String(body.repId || '').trim();
  const weekStart = String(body.weekStart || '').trim();
  if (!repId) throw Object.assign(new Error('REP_ID_REQUIRED'), { code: 'REP_ID_REQUIRED' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw Object.assign(new Error('VALID_WEEK_START_REQUIRED'), { code: 'VALID_WEEK_START_REQUIRED' });
  const revenueCents = Math.round(Math.max(0, Number(body.revenue || 0)) * 100);
  const data = {
    repId,
    weekStart,
    leadsContacted: nonnegative(body.leadsContacted),
    conversationsStarted: nonnegative(body.conversationsStarted),
    followupsCompleted: nonnegative(body.followupsCompleted),
    consultationsBooked: nonnegative(body.consultationsBooked),
    salesClosed: nonnegative(body.salesClosed),
    revenueCents,
    wins: String(body.wins || '').trim().slice(0, 4000),
    blockers: String(body.blockers || '').trim().slice(0, 4000),
    supportNeeded: String(body.supportNeeded || '').trim().slice(0, 4000),
    nextWeekCommitment: String(body.nextWeekCommitment || '').trim().slice(0, 4000),
    confidenceScore: clamp(nonnegative(body.confidenceScore) || 5, 1, 10)
  };
  data.performanceScore = performanceScore(data);
  return data;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'rep-weekly-checkin-portal', time: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'degraded', error: error.message });
  }
});

app.get('/api/reps', requireRep, async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email FROM sales_reps WHERE active = TRUE ORDER BY name');
    res.json({ reps: rows });
  } catch (error) { next(error); }
});

app.post('/api/reps', requireManager, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!name || !email.includes('@')) return res.status(400).json({ error: 'VALID_NAME_AND_EMAIL_REQUIRED' });
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      'INSERT INTO sales_reps(id,name,email) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name, active=TRUE RETURNING id,name,email',
      [id, name, email]
    );
    res.status(201).json({ rep: rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/checkins', requireRep, async (req, res, next) => {
  try {
    const data = normalizeCheckin(req.body);
    const id = crypto.randomUUID();
    const { rows } = await pool.query(`
      INSERT INTO rep_weekly_checkins(
        id,rep_id,week_start,leads_contacted,conversations_started,followups_completed,
        consultations_booked,sales_closed,revenue_cents,wins,blockers,support_needed,
        next_week_commitment,confidence_score,performance_score
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(rep_id,week_start) DO UPDATE SET
        leads_contacted=EXCLUDED.leads_contacted,
        conversations_started=EXCLUDED.conversations_started,
        followups_completed=EXCLUDED.followups_completed,
        consultations_booked=EXCLUDED.consultations_booked,
        sales_closed=EXCLUDED.sales_closed,
        revenue_cents=EXCLUDED.revenue_cents,
        wins=EXCLUDED.wins,
        blockers=EXCLUDED.blockers,
        support_needed=EXCLUDED.support_needed,
        next_week_commitment=EXCLUDED.next_week_commitment,
        confidence_score=EXCLUDED.confidence_score,
        performance_score=EXCLUDED.performance_score,
        manager_status='submitted',
        submitted_at=NOW()
      RETURNING *`,
      [id,data.repId,data.weekStart,data.leadsContacted,data.conversationsStarted,data.followupsCompleted,data.consultationsBooked,data.salesClosed,data.revenueCents,data.wins,data.blockers,data.supportNeeded,data.nextWeekCommitment,data.confidenceScore,data.performanceScore]
    );
    res.status(201).json({ checkin: rows[0] });
  } catch (error) {
    if (['REP_ID_REQUIRED','VALID_WEEK_START_REQUIRED'].includes(error.code)) return res.status(400).json({ error: error.code });
    next(error);
  }
});

app.get('/api/checkins', requireManager, async (req, res, next) => {
  try {
    const weekStart = String(req.query.weekStart || '').trim();
    const values = [];
    let where = '';
    if (weekStart) { values.push(weekStart); where = 'WHERE c.week_start = $1'; }
    const { rows } = await pool.query(`
      SELECT c.*, r.name AS rep_name, r.email AS rep_email
      FROM rep_weekly_checkins c JOIN sales_reps r ON r.id=c.rep_id
      ${where}
      ORDER BY c.week_start DESC, c.performance_score DESC, r.name`, values);
    const totals = rows.reduce((acc, row) => {
      acc.revenueCents += Number(row.revenue_cents || 0);
      acc.salesClosed += Number(row.sales_closed || 0);
      acc.consultationsBooked += Number(row.consultations_booked || 0);
      acc.followupsCompleted += Number(row.followups_completed || 0);
      return acc;
    }, { revenueCents: 0, salesClosed: 0, consultationsBooked: 0, followupsCompleted: 0 });
    res.json({ checkins: rows, totals });
  } catch (error) { next(error); }
});

app.patch('/api/checkins/:id/review', requireManager, async (req, res, next) => {
  try {
    const status = String(req.body?.status || 'reviewed');
    if (!['reviewed','follow-up-required','complete'].includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });
    const notes = String(req.body?.managerNotes || '').trim().slice(0, 4000);
    const { rows } = await pool.query(
      'UPDATE rep_weekly_checkins SET manager_status=$1, manager_notes=$2, reviewed_at=NOW() WHERE id=$3 RETURNING *',
      [status, notes, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'CHECKIN_NOT_FOUND' });
    res.json({ checkin: rows[0] });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', event: 'rep.portal.error', message: error.message }));
  res.status(500).json({ error: 'INTERNAL_ERROR' });
});

if (require.main === module) app.listen(port, () => console.log(JSON.stringify({ event: 'rep.portal.started', port })));

module.exports = { app, normalizeCheckin, performanceScore };
