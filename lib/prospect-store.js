'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createBusinessFingerprint } = require('./outreach-validation');

const STAGES = Object.freeze([
  'discovered','verification_pending','verified','research_pending','research_complete',
  'qualification_pending','qualified','disqualified','personalization_pending','ready_for_review',
  'approved_for_outreach','queued','sent','engaged','meeting_booked','opportunity','customer','nurture','suppressed'
]);

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function dateKey(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

class ProspectStore {
  constructor(filePath = process.env.PROSPECT_STORE_PATH || path.join(process.cwd(), 'data', 'prospects.json')) {
    this.filePath = filePath;
    this.dailyEmailLimit = Number(process.env.DAILY_EMAIL_LIMIT || 100);
    this.state = this.#load();
  }

  #empty() { return { version: 2, prospects: [], queue: [], events: [], dailyUsage: {} }; }
  #load() {
    try {
      const state = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      state.dailyUsage ||= {};
      return state;
    } catch (error) { if (error.code === 'ENOENT') return this.#empty(); throw error; }
  }
  #save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    fs.renameSync(temp, this.filePath);
  }
  #event(prospectId, type, data = {}, actor = 'system') {
    const event = { eventId: id('evt'), prospectId, type, actor, data, createdAt: now() };
    this.state.events.push(event);
    return event;
  }

  getDailyEmailQuota(day = dateKey()) {
    const sent = Number(this.state.dailyUsage?.[day]?.emailSent || 0);
    return { day, limit: this.dailyEmailLimit, sent, remaining: Math.max(0, this.dailyEmailLimit - sent), exhausted: sent >= this.dailyEmailLimit };
  }

  #reserveEmailSend(day = dateKey()) {
    const quota = this.getDailyEmailQuota(day);
    if (quota.exhausted) throw Object.assign(new Error(`Daily email quota of ${quota.limit} has been reached.`), { code: 'DAILY_EMAIL_QUOTA_REACHED', quota });
    this.state.dailyUsage[day] ||= { emailSent: 0 };
    this.state.dailyUsage[day].emailSent += 1;
    return this.getDailyEmailQuota(day);
  }

  create(input, actor = 'system') {
    const business = input.business || {};
    const fingerprint = createBusinessFingerprint(business);
    const duplicate = this.state.prospects.find(p => p.fingerprint === fingerprint);
    if (duplicate) return { prospect: duplicate, duplicate: true };
    const timestamp = now();
    const prospect = {
      prospectId: id('pro'), fingerprint, business, contact: input.contact || null,
      campaignId: input.campaignId || null, ownerId: input.ownerId || null,
      stage: 'discovered', status: 'active', score: null, enrichment: null,
      personalization: null, validation: null, nextAction: 'verify_identity',
      nextActionAt: null, createdAt: timestamp, updatedAt: timestamp
    };
    this.state.prospects.push(prospect);
    this.#event(prospect.prospectId, 'prospect.created', { campaignId: prospect.campaignId }, actor);
    this.#save();
    return { prospect, duplicate: false };
  }

  list(filters = {}) {
    return this.state.prospects.filter(p =>
      (!filters.stage || p.stage === filters.stage) &&
      (!filters.campaignId || p.campaignId === filters.campaignId) &&
      (!filters.ownerId || p.ownerId === filters.ownerId) &&
      (!filters.status || p.status === filters.status)
    );
  }

  get(prospectId) { return this.state.prospects.find(p => p.prospectId === prospectId) || null; }

  update(prospectId, patch, actor = 'system') {
    const prospect = this.get(prospectId);
    if (!prospect) return null;
    const protectedFields = new Set(['prospectId','fingerprint','createdAt']);
    for (const [key, value] of Object.entries(patch || {})) if (!protectedFields.has(key)) prospect[key] = value;
    prospect.updatedAt = now();
    this.#event(prospectId, 'prospect.updated', { fields: Object.keys(patch || {}) }, actor);
    this.#save();
    return prospect;
  }

  transition(prospectId, stage, metadata = {}, actor = 'system') {
    if (!STAGES.includes(stage)) throw Object.assign(new Error('Invalid prospect stage.'), { code: 'INVALID_STAGE' });
    const prospect = this.get(prospectId);
    if (!prospect) return null;
    const from = prospect.stage;
    prospect.stage = stage;
    prospect.updatedAt = now();
    if (stage === 'suppressed') prospect.status = 'suppressed';
    this.#event(prospectId, 'prospect.stage_changed', { from, to: stage, ...metadata }, actor);
    this.#save();
    return prospect;
  }

  enqueue(prospectId, authorization, message, scheduledAt = now(), actor = 'system') {
    const prospect = this.get(prospectId);
    if (!prospect) throw Object.assign(new Error('Prospect not found.'), { code: 'PROSPECT_NOT_FOUND' });
    if (!authorization?.authorized || !authorization?.idempotencyKey) throw Object.assign(new Error('Valid outreach authorization required.'), { code: 'AUTHORIZATION_REQUIRED' });
    if (prospect.status === 'suppressed') throw Object.assign(new Error('Suppressed prospect cannot be queued.'), { code: 'PROSPECT_SUPPRESSED' });
    const existing = this.state.queue.find(item => item.idempotencyKey === authorization.idempotencyKey);
    if (existing) return { item: existing, duplicate: true };
    const item = {
      queueId: id('que'), prospectId, campaignId: prospect.campaignId,
      channel: message.channel || 'email', recipient: message.recipient,
      subject: message.subject || null, body: message.body,
      messageVersion: message.messageVersion || null,
      validationRunId: authorization.validationRunId || null,
      idempotencyKey: authorization.idempotencyKey, status: 'pending',
      scheduledAt, attempts: 0, createdAt: now(), updatedAt: now()
    };
    this.state.queue.push(item);
    prospect.stage = 'queued'; prospect.updatedAt = now();
    this.#event(prospectId, 'outreach.queued', { queueId: item.queueId, channel: item.channel }, actor);
    this.#save();
    return { item, duplicate: false };
  }

  listQueue(filters = {}) {
    return this.state.queue.filter(item =>
      (!filters.status || item.status === filters.status) &&
      (!filters.campaignId || item.campaignId === filters.campaignId) &&
      (!filters.prospectId || item.prospectId === filters.prospectId)
    );
  }

  markQueue(queueId, status, metadata = {}, actor = 'system') {
    const item = this.state.queue.find(q => q.queueId === queueId);
    if (!item) return null;

    if (status === 'processing' && item.channel === 'email') {
      const quota = this.getDailyEmailQuota();
      if (quota.exhausted) throw Object.assign(new Error(`Daily email quota of ${quota.limit} has been reached.`), { code: 'DAILY_EMAIL_QUOTA_REACHED', quota });
    }

    if (status === 'sent' && item.channel === 'email' && item.status !== 'sent') {
      const quota = this.#reserveEmailSend();
      metadata = { ...metadata, dailyQuota: quota };
    }

    item.status = status; item.updatedAt = now();
    if (status === 'processing') item.attempts += 1;
    Object.assign(item, metadata);
    const stageMap = { sent: 'sent', replied: 'engaged', meeting_booked: 'meeting_booked', suppressed: 'suppressed' };
    if (stageMap[status]) this.transition(item.prospectId, stageMap[status], { queueId }, actor);
    else { this.#event(item.prospectId, `outreach.${status}`, { queueId, ...metadata }, actor); this.#save(); }
    return item;
  }

  timeline(prospectId) { return this.state.events.filter(e => e.prospectId === prospectId); }
  metrics() {
    const byStage = {};
    for (const p of this.state.prospects) byStage[p.stage] = (byStage[p.stage] || 0) + 1;
    const queue = {};
    for (const q of this.state.queue) queue[q.status] = (queue[q.status] || 0) + 1;
    return { prospects: this.state.prospects.length, byStage, queue, events: this.state.events.length, emailQuota: this.getDailyEmailQuota() };
  }
}

module.exports = { ProspectStore, STAGES };