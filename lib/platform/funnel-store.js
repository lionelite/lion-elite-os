'use strict';

/**
 * Persistence for BuildPipeline VSL funnels — the "persist /api/funnel-events
 * into the analytics store" and "hook lead_qualified and booking_click into CRM
 * stages" targets from apps/buildpipeline/README.md.
 *
 * Writes land in the existing GTM tables rather than a parallel CRM: a funnel
 * application becomes a gtm_prospects row (with the answers as gtm_evidence), a
 * booking becomes gtm_meetings + gtm_opportunities, and follow-up becomes
 * gtm_agent_tasks in draft_only mode. The funnel's own tables (gtm_funnels,
 * gtm_funnel_events, gtm_funnel_leads) hold config, PII-free analytics and the
 * SMS consent record.
 *
 * Same split as workspace-store.js: MemoryFunnelStore for dev/tests without a
 * database, PostgresFunnelStore when DATABASE_URL is set.
 */

const crypto = require('crypto');
const db = require('../database');
const {
  FunnelError,
  EVENT_STEPS,
  normalizeSlug,
  normalizeFunnelConfig,
  FUNNEL_STATUSES,
  eventKey,
  scoreLead,
  crmTransition,
  planFollowUps,
  funnelReport,
} = require('./vsl-funnel');

const DELEGATED_BY = 'vsl-funnel';

function prepareFunnel(input = {}) {
  const slug = normalizeSlug(input.slug);
  const status = String(input.status || 'draft');
  if (!FUNNEL_STATUSES.includes(status)) throw new FunnelError(`unknown funnel status "${status}"`, 'INVALID_STATUS');
  const config = normalizeFunnelConfig(input.config || {}, { status });
  return { slug, status, config, campaignId: input.campaignId || null };
}

function lifecycleEvent(funnel, type, sessionId, prospectId, discriminator = '') {
  return {
    type,
    step: EVENT_STEPS[type],
    sessionId,
    prospectId,
    metadata: {},
    eventKey: eventKey({ type, sessionId, discriminator }),
  };
}

function parseStartsAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new FunnelError('startsAt is not a valid date', 'INVALID_DATE');
  return d;
}

class MemoryFunnelStore {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.funnels = new Map(); // slug -> funnel
    this.events = [];
    this.leads = new Map(); // `${funnelId}:${sessionId}` -> lead
    this.prospects = new Map();
    this.evidence = [];
    this.meetings = new Map();
    this.opportunities = new Map();
    this.tasks = [];
    this.audit = [];
  }

  async saveFunnel(workspaceId, input) {
    if (!workspaceId) throw new FunnelError('workspaceId is required', 'MISSING_WORKSPACE');
    const f = prepareFunnel(input);
    const existing = this.funnels.get(f.slug);
    if (existing && existing.workspaceId !== workspaceId) throw new FunnelError('slug is already in use', 'SLUG_TAKEN', 409);
    const row = {
      funnelId: existing ? existing.funnelId : crypto.randomUUID(),
      workspaceId,
      campaignId: f.campaignId,
      slug: f.slug,
      status: f.status,
      config: f.config,
      updatedAt: this.now().toISOString(),
    };
    this.funnels.set(f.slug, row);
    this.audit.push({ workspaceId, eventType: existing ? 'funnel.updated' : 'funnel.created', entityId: row.funnelId });
    return row;
  }

  async getFunnel(workspaceId, slug) {
    const f = this.funnels.get(String(slug || '').toLowerCase());
    return f && f.workspaceId === workspaceId ? f : null;
  }

  async listFunnels(workspaceId) {
    return [...this.funnels.values()].filter(f => f.workspaceId === workspaceId);
  }

  async getPublishedFunnel(slug) {
    const f = this.funnels.get(String(slug || '').toLowerCase());
    return f && f.status === 'published' ? f : null;
  }

  _insertEvent(funnel, ev) {
    if (this.events.some(e => e.funnelId === funnel.funnelId && e.eventKey === ev.eventKey)) return false;
    this.events.push({ ...ev, funnelId: funnel.funnelId, workspaceId: funnel.workspaceId, occurredAt: this.now().toISOString() });
    return true;
  }

  _queueTasks(funnel, prospectId, tasks) {
    for (const t of tasks) {
      this.tasks.push({
        taskId: crypto.randomUUID(),
        workspaceId: funnel.workspaceId,
        campaignId: funnel.campaignId,
        agentKey: t.agentKey,
        objective: t.objective,
        status: 'queued',
        delegatedBy: DELEGATED_BY,
        runAfter: t.runAfter,
        output: { channel: t.channel, delivery: t.delivery, cancelIf: t.cancelIf || null, funnelSlug: funnel.slug, prospectId },
      });
    }
    return tasks.length;
  }

  async recordClientEvent(funnel, ev) {
    const lead = this.leads.get(`${funnel.funnelId}:${ev.sessionId}`);
    const recorded = this._insertEvent(funnel, { ...ev, prospectId: lead ? lead.prospectId : null });
    let crm = null;
    if (recorded && ev.type === 'booking_click' && lead) {
      const t = crmTransition('booking_click');
      const open = [...this.meetings.values()].find(m => m.prospectId === lead.prospectId && ['proposed', 'booked'].includes(m.status));
      if (!open) {
        const meetingId = crypto.randomUUID();
        this.meetings.set(meetingId, { meetingId, workspaceId: funnel.workspaceId, prospectId: lead.prospectId, status: t.meetingStatus, bookingUrl: funnel.config.calendarUrl });
      }
      const tasks = planFollowUps('booking_click', { lead, now: this.now() });
      crm = { meetingStatus: open ? open.status : t.meetingStatus, tasksQueued: this._queueTasks(funnel, lead.prospectId, tasks) };
    }
    return { recorded, duplicate: !recorded, crm };
  }

  async captureLead(funnel, lead) {
    const key = `${funnel.funnelId}:${lead.sessionId}`;
    const existing = this.leads.get(key);
    if (existing) return { prospectId: existing.prospectId, duplicate: true, tasksQueued: 0 };

    const prospectId = crypto.randomUUID();
    const t = crmTransition('lead_qualified');
    this.prospects.set(prospectId, {
      prospectId,
      workspaceId: funnel.workspaceId,
      campaignId: funnel.campaignId,
      companyName: lead.companyName,
      contactName: lead.name,
      email: lead.email,
      phone: lead.phone,
      status: t.prospectStatus,
      fitScore: scoreLead(lead),
      intentHeat: 4,
      nextAction: 'book_call',
    });
    for (const a of lead.answers) this.evidence.push({ prospectId, type: 'funnel_answer', label: a.question, value: a.answer });
    this.leads.set(key, { funnelId: funnel.funnelId, prospectId, sessionId: lead.sessionId, smsConsent: lead.smsConsent, consentText: lead.consentText, answers: lead.answers });
    this._insertEvent(funnel, lifecycleEvent(funnel, 'lead_qualified', lead.sessionId, prospectId));
    const tasksQueued = this._queueTasks(funnel, prospectId, planFollowUps('lead_qualified', { lead, now: this.now() }));
    this._insertEvent(funnel, lifecycleEvent(funnel, 'follow_up_planned', lead.sessionId, prospectId, 'lead_qualified'));
    this.audit.push({ workspaceId: funnel.workspaceId, eventType: 'funnel.lead_qualified', entityId: prospectId });
    return { prospectId, duplicate: false, tasksQueued };
  }

  _resolveLead(funnel, { sessionId, prospectId }) {
    for (const lead of this.leads.values()) {
      if (lead.funnelId !== funnel.funnelId) continue;
      if ((sessionId && lead.sessionId === sessionId) || (prospectId && lead.prospectId === prospectId)) return lead;
    }
    return null;
  }

  async confirmBooking(funnel, input = {}) {
    const lead = this._resolveLead(funnel, input);
    if (!lead) throw new FunnelError('no funnel application found for that session or prospect', 'LEAD_NOT_FOUND', 404);
    const startsAt = parseStartsAt(input.startsAt);
    const t = crmTransition('booking_confirmed');
    const ev = lifecycleEvent(funnel, 'booking_confirmed', lead.sessionId, lead.prospectId);
    if (!this._insertEvent(funnel, ev)) return { prospectId: lead.prospectId, duplicate: true, tasksQueued: 0 };

    let meeting = [...this.meetings.values()].find(m => m.prospectId === lead.prospectId && m.status === 'proposed');
    if (!meeting) {
      meeting = { meetingId: crypto.randomUUID(), workspaceId: funnel.workspaceId, prospectId: lead.prospectId };
      this.meetings.set(meeting.meetingId, meeting);
    }
    Object.assign(meeting, { status: t.meetingStatus, startsAt: startsAt ? startsAt.toISOString() : null, externalCalendarId: input.externalCalendarId || null });
    this.prospects.get(lead.prospectId).status = t.prospectStatus;
    this.opportunities.set(lead.prospectId, { prospectId: lead.prospectId, stage: t.opportunityStage });
    let tasksCancelled = 0;
    for (const task of this.tasks) {
      if (task.status === 'queued' && task.output.prospectId === lead.prospectId && task.output.cancelIf === 'booking_confirmed') {
        task.status = 'cancelled';
        tasksCancelled += 1;
      }
    }
    const tasksQueued = this._queueTasks(funnel, lead.prospectId, planFollowUps('booking_confirmed', { lead, meeting: { startsAt }, now: this.now() }));
    this._insertEvent(funnel, lifecycleEvent(funnel, 'follow_up_planned', lead.sessionId, lead.prospectId, 'booking_confirmed'));
    this.audit.push({ workspaceId: funnel.workspaceId, eventType: 'funnel.booking_confirmed', entityId: lead.prospectId });
    return { prospectId: lead.prospectId, meetingId: meeting.meetingId, duplicate: false, tasksQueued, tasksCancelled };
  }

  async report(funnel) {
    return funnelReport(this.events.filter(e => e.funnelId === funnel.funnelId));
  }
}

const FUNNEL_COLUMNS = `funnel_id AS "funnelId", workspace_id AS "workspaceId", campaign_id AS "campaignId",
  slug, status, config, updated_at AS "updatedAt"`;

class PostgresFunnelStore {
  async saveFunnel(workspaceId, input) {
    if (!workspaceId) throw new FunnelError('workspaceId is required', 'MISSING_WORKSPACE');
    const f = prepareFunnel(input);
    // Only update a row the caller's workspace already owns; a slug owned by
    // another workspace yields no row, which is reported as a conflict.
    const result = await db.query(
      `INSERT INTO gtm_funnels (workspace_id, campaign_id, slug, status, config)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (slug) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, status = EXCLUDED.status,
         config = EXCLUDED.config, updated_at = now()
       WHERE gtm_funnels.workspace_id = EXCLUDED.workspace_id
       RETURNING ${FUNNEL_COLUMNS}`,
      [workspaceId, f.campaignId, f.slug, f.status, f.config]
    );
    const row = result.rows[0];
    if (!row) throw new FunnelError('slug is already in use', 'SLUG_TAKEN', 409);
    await db.query(
      `INSERT INTO gtm_audit_events (workspace_id, actor_type, event_type, entity_type, entity_id, data)
       VALUES ($1,'user','funnel.saved','gtm_funnel',$2,$3)`,
      [workspaceId, row.funnelId, { slug: row.slug, status: row.status }]
    );
    return row;
  }

  async getFunnel(workspaceId, slug) {
    const r = await db.query(`SELECT ${FUNNEL_COLUMNS} FROM gtm_funnels WHERE workspace_id=$1 AND slug=$2`, [workspaceId, String(slug || '').toLowerCase()]);
    return r.rows[0] || null;
  }

  async listFunnels(workspaceId) {
    const r = await db.query(`SELECT ${FUNNEL_COLUMNS} FROM gtm_funnels WHERE workspace_id=$1 ORDER BY updated_at DESC`, [workspaceId]);
    return r.rows;
  }

  async getPublishedFunnel(slug) {
    const r = await db.query(`SELECT ${FUNNEL_COLUMNS} FROM gtm_funnels WHERE slug=$1 AND status='published'`, [String(slug || '').toLowerCase()]);
    return r.rows[0] || null;
  }

  async _insertEvent(client, funnel, ev) {
    const r = await client.query(
      `INSERT INTO gtm_funnel_events (workspace_id, funnel_id, event_key, event_type, step, session_id, prospect_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (funnel_id, event_key) DO NOTHING
       RETURNING funnel_event_id`,
      [funnel.workspaceId, funnel.funnelId, ev.eventKey, ev.type, ev.step, ev.sessionId, ev.prospectId || null, ev.metadata || {}]
    );
    return r.rowCount === 1;
  }

  async _queueTasks(client, funnel, prospectId, tasks) {
    for (const t of tasks) {
      await client.query(
        `INSERT INTO gtm_agent_tasks (workspace_id, campaign_id, agent_key, objective, status, delegated_by, output, run_after)
         VALUES ($1,$2,$3,$4,'queued',$5,$6,$7)`,
        [funnel.workspaceId, funnel.campaignId, t.agentKey, t.objective, DELEGATED_BY,
          { channel: t.channel, delivery: t.delivery, cancelIf: t.cancelIf || null, funnelSlug: funnel.slug, prospectId }, t.runAfter]
      );
    }
    return tasks.length;
  }

  async _leadFor(client, funnel, { sessionId, prospectId }) {
    const r = await client.query(
      `SELECT prospect_id AS "prospectId", session_id AS "sessionId", sms_consent AS "smsConsent"
       FROM gtm_funnel_leads WHERE funnel_id=$1 AND (session_id=$2 OR prospect_id=$3) LIMIT 1`,
      [funnel.funnelId, sessionId || '', prospectId || null]
    );
    return r.rows[0] || null;
  }

  async recordClientEvent(funnel, ev) {
    return db.withTransaction(async client => {
      const lead = await this._leadFor(client, funnel, { sessionId: ev.sessionId });
      const recorded = await this._insertEvent(client, funnel, { ...ev, prospectId: lead ? lead.prospectId : null });
      let crm = null;
      if (recorded && ev.type === 'booking_click' && lead) {
        const t = crmTransition('booking_click');
        const open = await client.query(
          `SELECT status FROM gtm_meetings WHERE workspace_id=$1 AND prospect_id=$2 AND status IN ('proposed','booked') LIMIT 1`,
          [funnel.workspaceId, lead.prospectId]
        );
        if (!open.rowCount) {
          await client.query(
            `INSERT INTO gtm_meetings (workspace_id, prospect_id, campaign_id, status, booking_url, notes)
             VALUES ($1,$2,$3,$4,$5,'Calendar opened from VSL funnel; not yet confirmed')`,
            [funnel.workspaceId, lead.prospectId, funnel.campaignId, t.meetingStatus, funnel.config.calendarUrl || null]
          );
        }
        const tasksQueued = await this._queueTasks(client, funnel, lead.prospectId, planFollowUps('booking_click', { lead }));
        crm = { meetingStatus: open.rowCount ? open.rows[0].status : t.meetingStatus, tasksQueued };
      }
      return { recorded, duplicate: !recorded, crm };
    });
  }

  async captureLead(funnel, lead) {
    return db.withTransaction(async client => {
      const existing = await this._leadFor(client, funnel, { sessionId: lead.sessionId });
      if (existing) return { prospectId: existing.prospectId, duplicate: true, tasksQueued: 0 };
      const t = crmTransition('lead_qualified');
      const p = await client.query(
        `INSERT INTO gtm_prospects (workspace_id, campaign_id, company_name, contact_name, email, phone, status, fit_score, intent_heat, confidence, next_action, last_signal_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,4,100,'book_call',now())
         RETURNING prospect_id AS "prospectId"`,
        [funnel.workspaceId, funnel.campaignId, lead.companyName, lead.name, lead.email, lead.phone, t.prospectStatus, scoreLead(lead)]
      );
      const { prospectId } = p.rows[0];
      for (const a of lead.answers) {
        await client.query(
          `INSERT INTO gtm_evidence (workspace_id, prospect_id, type, label, value, metadata)
           VALUES ($1,$2,'funnel_answer',$3,$4,$5)`,
          [funnel.workspaceId, prospectId, a.question, a.answer, { funnelSlug: funnel.slug, selfReported: true }]
        );
      }
      await client.query(
        `INSERT INTO gtm_funnel_leads (workspace_id, funnel_id, prospect_id, session_id, answers, sms_consent, sms_consent_text, sms_consent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [funnel.workspaceId, funnel.funnelId, prospectId, lead.sessionId, JSON.stringify(lead.answers), lead.smsConsent, lead.consentText, lead.smsConsent ? new Date() : null]
      );
      await this._insertEvent(client, funnel, lifecycleEvent(funnel, 'lead_qualified', lead.sessionId, prospectId));
      const tasksQueued = await this._queueTasks(client, funnel, prospectId, planFollowUps('lead_qualified', { lead }));
      await this._insertEvent(client, funnel, lifecycleEvent(funnel, 'follow_up_planned', lead.sessionId, prospectId, 'lead_qualified'));
      await client.query(
        `INSERT INTO gtm_audit_events (workspace_id, actor_type, actor_id, event_type, entity_type, entity_id, data)
         VALUES ($1,'system',$2,'funnel.lead_qualified','gtm_prospect',$3,$4)`,
        [funnel.workspaceId, DELEGATED_BY, prospectId, { funnelSlug: funnel.slug, smsConsent: lead.smsConsent }]
      );
      return { prospectId, duplicate: false, tasksQueued };
    });
  }

  async confirmBooking(funnel, input = {}) {
    const startsAt = parseStartsAt(input.startsAt);
    return db.withTransaction(async client => {
      const lead = await this._leadFor(client, funnel, input);
      if (!lead) throw new FunnelError('no funnel application found for that session or prospect', 'LEAD_NOT_FOUND', 404);
      const t = crmTransition('booking_confirmed');
      const inserted = await this._insertEvent(client, funnel, lifecycleEvent(funnel, 'booking_confirmed', lead.sessionId, lead.prospectId));
      if (!inserted) return { prospectId: lead.prospectId, duplicate: true, tasksQueued: 0 };

      const proposed = await client.query(
        `UPDATE gtm_meetings SET status=$3, starts_at=$4, external_calendar_id=$5, updated_at=now()
         WHERE meeting_id = (SELECT meeting_id FROM gtm_meetings WHERE workspace_id=$1 AND prospect_id=$2 AND status='proposed' ORDER BY created_at DESC LIMIT 1)
         RETURNING meeting_id AS "meetingId"`,
        [funnel.workspaceId, lead.prospectId, t.meetingStatus, startsAt, input.externalCalendarId || null]
      );
      let meetingId = proposed.rows[0] && proposed.rows[0].meetingId;
      if (!meetingId) {
        const m = await client.query(
          `INSERT INTO gtm_meetings (workspace_id, prospect_id, campaign_id, status, starts_at, booking_url, external_calendar_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING meeting_id AS "meetingId"`,
          [funnel.workspaceId, lead.prospectId, funnel.campaignId, t.meetingStatus, startsAt, funnel.config.calendarUrl || null, input.externalCalendarId || null]
        );
        meetingId = m.rows[0].meetingId;
      }
      await client.query(`UPDATE gtm_prospects SET status=$3, next_action='hold_call', updated_at=now() WHERE workspace_id=$1 AND prospect_id=$2`,
        [funnel.workspaceId, lead.prospectId, t.prospectStatus]);
      await client.query(
        `INSERT INTO gtm_opportunities (workspace_id, prospect_id, campaign_id, stage, next_action)
         VALUES ($1,$2,$3,$4,'hold_call')
         ON CONFLICT (workspace_id, prospect_id) DO UPDATE SET stage=EXCLUDED.stage, next_action=EXCLUDED.next_action, updated_at=now()
         WHERE gtm_opportunities.stage IN ('replied','meeting')`,
        [funnel.workspaceId, lead.prospectId, funnel.campaignId, t.opportunityStage]
      );
      // The "calendar opened but never booked" rescue is moot now.
      const cancelled = await client.query(
        `UPDATE gtm_agent_tasks SET status='cancelled', updated_at=now()
         WHERE workspace_id=$1 AND delegated_by=$2 AND status='queued'
           AND output->>'prospectId'=$3 AND output->>'cancelIf'='booking_confirmed'`,
        [funnel.workspaceId, DELEGATED_BY, lead.prospectId]
      );
      const tasksQueued = await this._queueTasks(client, funnel, lead.prospectId, planFollowUps('booking_confirmed', { lead, meeting: { startsAt } }));
      await this._insertEvent(client, funnel, lifecycleEvent(funnel, 'follow_up_planned', lead.sessionId, lead.prospectId, 'booking_confirmed'));
      await client.query(
        `INSERT INTO gtm_audit_events (workspace_id, actor_type, actor_id, event_type, entity_type, entity_id, data)
         VALUES ($1,$2,$3,'funnel.booking_confirmed','gtm_meeting',$4,$5)`,
        [funnel.workspaceId, input.actorType || 'user', input.actorId || null, meetingId, { funnelSlug: funnel.slug, prospectId: lead.prospectId }]
      );
      return { prospectId: lead.prospectId, meetingId, duplicate: false, tasksQueued, tasksCancelled: cancelled.rowCount };
    });
  }

  async report(funnel) {
    const r = await db.query(
      `SELECT event_type AS type, session_id AS "sessionId" FROM gtm_funnel_events WHERE funnel_id=$1`,
      [funnel.funnelId]
    );
    return funnelReport(r.rows);
  }
}

function createFunnelStore() {
  return process.env.DATABASE_URL ? new PostgresFunnelStore() : new MemoryFunnelStore();
}

module.exports = { createFunnelStore, MemoryFunnelStore, PostgresFunnelStore, prepareFunnel };
