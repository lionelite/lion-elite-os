'use strict';

const crypto = require('crypto');
const db = require('../database');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function normalizeProfile(input = {}) {
  return {
    websiteUrl: String(input.websiteUrl || '').trim(),
    companyDescription: String(input.companyDescription || '').trim(),
    offerName: String(input.offerName || '').trim(),
    offerDescription: String(input.offerDescription || '').trim(),
    primaryGoal: String(input.primaryGoal || 'book_meetings').trim(),
    targetGeography: String(input.targetGeography || '').trim(),
    icp: input.icp && typeof input.icp === 'object' ? input.icp : {},
    exclusions: Array.isArray(input.exclusions) ? input.exclusions : [],
    messagingAngles: Array.isArray(input.messagingAngles) ? input.messagingAngles : []
  };
}

class MemoryWorkspaceStore {
  constructor() {
    this.workspaces = new Map();
    this.profiles = new Map();
    this.campaigns = new Map();
    this.audit = [];
  }

  async createWorkspace({ name, plan = 'solo' }) {
    if (!name || !String(name).trim()) throw new Error('workspace name is required');
    const workspaceId = crypto.randomUUID();
    const base = slugify(name) || 'workspace';
    const slug = [...this.workspaces.values()].some(x => x.slug === base) ? `${base}-${workspaceId.slice(0, 6)}` : base;
    const row = { workspaceId, name: String(name).trim(), slug, plan, status: 'active' };
    this.workspaces.set(workspaceId, row);
    this.audit.push({ workspaceId, actorType: 'system', eventType: 'workspace.created' });
    return row;
  }

  async getWorkspace(workspaceId) {
    return this.workspaces.get(workspaceId) || null;
  }

  async saveProfile(workspaceId, input) {
    if (!this.workspaces.has(workspaceId)) return null;
    const profile = { workspaceId, ...normalizeProfile(input), onboardingStatus: 'ready' };
    this.profiles.set(workspaceId, profile);
    this.audit.push({ workspaceId, actorType: 'user', eventType: 'company_profile.saved' });
    return profile;
  }

  async getProfile(workspaceId) {
    return this.profiles.get(workspaceId) || null;
  }

  async createCampaign(workspaceId, input = {}) {
    if (!this.workspaces.has(workspaceId)) return null;
    if (!input.name || !String(input.name).trim()) throw new Error('campaign name is required');
    const campaign = {
      campaignId: crypto.randomUUID(),
      workspaceId,
      name: String(input.name).trim(),
      objective: String(input.objective || 'book_meetings'),
      status: 'draft',
      offer: input.offer && typeof input.offer === 'object' ? input.offer : {},
      icp: input.icp && typeof input.icp === 'object' ? input.icp : {},
      filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
      exclusions: Array.isArray(input.exclusions) ? input.exclusions : [],
      channels: Array.isArray(input.channels) && input.channels.length ? input.channels : ['email'],
      sequence: Array.isArray(input.sequence) ? input.sequence : [],
      successEvent: String(input.successEvent || 'meeting_booked'),
      sendPolicy: input.sendPolicy === 'autopilot' ? 'autopilot' : 'supervised',
      intentThreshold: Math.max(1, Math.min(5, Number(input.intentThreshold || 4)))
    };
    this.campaigns.set(campaign.campaignId, campaign);
    this.audit.push({ workspaceId, actorType: 'user', eventType: 'campaign.created', entityId: campaign.campaignId });
    return campaign;
  }

  async listCampaigns(workspaceId) {
    return [...this.campaigns.values()].filter(x => x.workspaceId === workspaceId);
  }
}

class PostgresWorkspaceStore {
  async createWorkspace({ name, plan = 'solo' }) {
    if (!name || !String(name).trim()) throw new Error('workspace name is required');
    const base = slugify(name) || 'workspace';
    const suffix = crypto.randomUUID().slice(0, 6);
    const result = await db.query(
      `INSERT INTO gtm_workspaces (name, slug, plan)
       VALUES ($1, $2, $3)
       RETURNING workspace_id AS "workspaceId", name, slug, plan, status`,
      [String(name).trim(), `${base}-${suffix}`, plan]
    );
    const row = result.rows[0];
    await db.query(
      `INSERT INTO gtm_audit_events (workspace_id, actor_type, event_type)
       VALUES ($1, 'system', 'workspace.created')`,
      [row.workspaceId]
    );
    return row;
  }

  async getWorkspace(workspaceId) {
    const result = await db.query(
      `SELECT workspace_id AS "workspaceId", name, slug, plan, status
       FROM gtm_workspaces WHERE workspace_id = $1`,
      [workspaceId]
    );
    return result.rows[0] || null;
  }

  async saveProfile(workspaceId, input) {
    const p = normalizeProfile(input);
    const result = await db.query(
      `INSERT INTO gtm_workspace_profiles (
        workspace_id, website_url, company_description, offer_name, offer_description,
        primary_goal, target_geography, icp, exclusions, messaging_angles, onboarding_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready')
      ON CONFLICT (workspace_id) DO UPDATE SET
        website_url = EXCLUDED.website_url,
        company_description = EXCLUDED.company_description,
        offer_name = EXCLUDED.offer_name,
        offer_description = EXCLUDED.offer_description,
        primary_goal = EXCLUDED.primary_goal,
        target_geography = EXCLUDED.target_geography,
        icp = EXCLUDED.icp,
        exclusions = EXCLUDED.exclusions,
        messaging_angles = EXCLUDED.messaging_angles,
        onboarding_status = 'ready',
        updated_at = now()
      RETURNING workspace_id AS "workspaceId",
        website_url AS "websiteUrl",
        company_description AS "companyDescription",
        offer_name AS "offerName",
        offer_description AS "offerDescription",
        primary_goal AS "primaryGoal",
        target_geography AS "targetGeography",
        icp, exclusions, messaging_angles AS "messagingAngles",
        onboarding_status AS "onboardingStatus"`,
      [workspaceId,p.websiteUrl,p.companyDescription,p.offerName,p.offerDescription,p.primaryGoal,p.targetGeography,p.icp,p.exclusions,p.messagingAngles]
    );
    if (!result.rows[0]) return null;
    await db.query(
      `INSERT INTO gtm_audit_events (workspace_id, actor_type, event_type)
       VALUES ($1, 'user', 'company_profile.saved')`,
      [workspaceId]
    );
    return result.rows[0];
  }

  async getProfile(workspaceId) {
    const result = await db.query(
      `SELECT workspace_id AS "workspaceId",
        website_url AS "websiteUrl",
        company_description AS "companyDescription",
        offer_name AS "offerName",
        offer_description AS "offerDescription",
        primary_goal AS "primaryGoal",
        target_geography AS "targetGeography",
        icp, exclusions, messaging_angles AS "messagingAngles",
        onboarding_status AS "onboardingStatus"
       FROM gtm_workspace_profiles WHERE workspace_id = $1`,
      [workspaceId]
    );
    return result.rows[0] || null;
  }

  async createCampaign(workspaceId, input = {}) {
    if (!input.name || !String(input.name).trim()) throw new Error('campaign name is required');
    const result = await db.query(
      `INSERT INTO gtm_campaigns (
        workspace_id, name, objective, offer, icp, filters, exclusions, channels, sequence, success_event, send_policy, intent_threshold
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING campaign_id AS "campaignId", workspace_id AS "workspaceId", name, objective, status,
        offer, icp, filters, exclusions, channels, sequence, success_event AS "successEvent",
        send_policy AS "sendPolicy", intent_threshold AS "intentThreshold"`,
      [
        workspaceId,
        String(input.name).trim(),
        String(input.objective || 'book_meetings'),
        input.offer && typeof input.offer === 'object' ? input.offer : {},
        input.icp && typeof input.icp === 'object' ? input.icp : {},
        input.filters && typeof input.filters === 'object' ? input.filters : {},
        Array.isArray(input.exclusions) ? input.exclusions : [],
        Array.isArray(input.channels) && input.channels.length ? input.channels : ['email'],
        Array.isArray(input.sequence) ? input.sequence : [],
        String(input.successEvent || 'meeting_booked'),
        input.sendPolicy === 'autopilot' ? 'autopilot' : 'supervised',
        Math.max(1, Math.min(5, Number(input.intentThreshold || 4)))
      ]
    );
    const row = result.rows[0];
    await db.query(
      `INSERT INTO gtm_audit_events (workspace_id, actor_type, event_type, entity_type, entity_id)
       VALUES ($1, 'user', 'campaign.created', 'campaign', $2)`,
      [workspaceId, row.campaignId]
    );
    return row;
  }

  async listCampaigns(workspaceId) {
    const result = await db.query(
      `SELECT campaign_id AS "campaignId", workspace_id AS "workspaceId", name, objective, status,
        offer, icp, filters, exclusions, channels, sequence, success_event AS "successEvent",
        send_policy AS "sendPolicy", intent_threshold AS "intentThreshold"
       FROM gtm_campaigns WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return result.rows;
  }
}

function createWorkspaceStore() {
  return process.env.DATABASE_URL ? new PostgresWorkspaceStore() : new MemoryWorkspaceStore();
}

module.exports = { createWorkspaceStore, MemoryWorkspaceStore, PostgresWorkspaceStore, normalizeProfile, slugify };
