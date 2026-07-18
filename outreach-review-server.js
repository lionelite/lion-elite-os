'use strict';

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { PostgresProspectStore } = require('./lib/postgres-prospect-store');
const { listReviewItems, getReviewItem, updateReviewDraft } = require('./lib/outreach-review');
const { addJob } = require('./lib/job-queues');

const app = express();
const port = Number(process.env.PORT || process.env.OUTREACH_REVIEW_PORT || 3002);
const store = new PostgresProspectStore();

app.use(express.json({ limit: '256kb' }));

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireReviewToken(req, res, next) {
  const expected = process.env.OUTREACH_REVIEW_TOKEN;
  if (!expected) return res.status(503).json({ error: 'REVIEW_TOKEN_NOT_CONFIGURED' });
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(actual, expected)) return res.status(401).json({ error: 'UNAUTHORIZED' });
  next();
}

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'lion-elite-outreach-review' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'outreach-review.html')));

app.get('/api/review', requireReviewToken, async (req, res, next) => {
  try {
    const items = await listReviewItems({ limit: req.query.limit || 10 });
    res.json({ items, count: items.length, quota: await store.getDailyEmailQuota() });
  } catch (error) { next(error); }
});

app.patch('/api/review/:id', requireReviewToken, async (req, res, next) => {
  try {
    const item = await updateReviewDraft(req.params.id, {
      subject: typeof req.body.subject === 'string' ? req.body.subject : undefined,
      body: typeof req.body.body === 'string' ? req.body.body : undefined
    });
    if (!item) return res.status(404).json({ error: 'REVIEW_ITEM_NOT_FOUND_OR_ALREADY_DECIDED' });
    res.json({ item });
  } catch (error) { next(error); }
});

app.post('/api/review/:id/approve', requireReviewToken, async (req, res, next) => {
  try {
    let item = await getReviewItem(req.params.id);
    if (!item || item.status !== 'awaiting_review') return res.status(409).json({ error: 'ITEM_NOT_AWAITING_REVIEW' });

    if (typeof req.body.subject === 'string' || typeof req.body.body === 'string') {
      item = await updateReviewDraft(req.params.id, { subject: req.body.subject, body: req.body.body });
    }
    if (!item.body || !item.recipient) return res.status(422).json({ error: 'INCOMPLETE_DRAFT' });

    const prospect = await store.get(item.prospectId);
    if (!prospect || prospect.status === 'suppressed') return res.status(422).json({ error: 'PROSPECT_NOT_ELIGIBLE' });

    const quota = await store.getDailyEmailQuota();
    if (item.channel === 'email' && quota.exhausted) return res.status(429).json({ error: 'DAILY_EMAIL_QUOTA_REACHED', quota });

    await store.markQueue(item.queueId, 'pending', { approvedBy: 'human-review' }, 'human-review');
    await store.transition(item.prospectId, 'approved_for_outreach', { queueId: item.queueId }, 'human-review');

    await addJob('dispatch', 'dispatch-authorized-outreach', {
      queueId: item.queueId,
      prospect,
      draft: { recipient: item.recipient, subject: item.subject, body: item.body },
      authorization: { authorized: true, idempotencyKey: item.idempotencyKey, validationRunId: item.validationRunId }
    }, { jobId: `human-approved:${item.idempotencyKey}` });

    res.json({ approved: true, queueId: item.queueId, recipient: item.recipient });
  } catch (error) { next(error); }
});

app.post('/api/review/:id/skip', requireReviewToken, async (req, res, next) => {
  try {
    const item = await getReviewItem(req.params.id);
    if (!item || item.status !== 'awaiting_review') return res.status(409).json({ error: 'ITEM_NOT_AWAITING_REVIEW' });
    await store.markQueue(item.queueId, 'skipped', { reason: req.body?.reason || 'human_skip' }, 'human-review');
    await store.transition(item.prospectId, 'nurture', { queueId: item.queueId, reason: req.body?.reason || 'human_skip' }, 'human-review');
    res.json({ skipped: true, queueId: item.queueId });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.code || 'REVIEW_SERVER_ERROR', message: error.message });
});

app.listen(port, () => console.log(`Lion Elite outreach review running on port ${port}`));

module.exports = { app, requireReviewToken, safeEqual };
