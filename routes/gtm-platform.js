'use strict';

const express = require('express');
const { planCampaign } = require('../lib/platform/campaign-planner');
const { classifyReply, draftReply } = require('../lib/platform/reply-assistant');
const { integrationReadiness } = require('../lib/platform/integrations');
const { priceAction } = require('../lib/platform/usage-meter');
const { CsvSourceProvider, runSourcing } = require('../lib/platform/sourcing');
const { ApolloProvider } = require('../lib/platform/sources/apollo');
const { evaluateSend } = require('../lib/platform/sender-policy');
const { importRows } = require('../lib/platform/csv-import');
const { createAuthMiddleware } = require('../lib/platform/security/auth-middleware');

function createGtmPlatformRouter({ store, authStore }) {
  const router = express.Router();
  const auth = authStore ? createAuthMiddleware(authStore) : null;
  const requireSession = auth ? auth.requireSession : (_req,_res,next)=>next();
  const requireViewer = auth ? auth.requireWorkspaceRole('viewer') : (_req,_res,next)=>next();
  const requireOperator = auth ? auth.requireWorkspaceRole('operator') : (_req,_res,next)=>next();
  const requireAdmin = auth ? auth.requireWorkspaceRole('admin') : (_req,_res,next)=>next();

  router.post('/auth/exchange', async (req, res) => {
    try {
      if (!authStore) return res.status(503).json({ error: 'auth store unavailable' });
      const expected = String(process.env.GTM_AUTH_EXCHANGE_SECRET || '');
      const provided = String(req.headers['x-gtm-auth-exchange-secret'] || '');
      if (!expected || provided !== expected) return res.status(401).json({ error: 'trusted identity exchange denied' });
      const user = await authStore.upsertUser({ email: req.body?.email, displayName: req.body?.displayName || '' });
      const session = await authStore.issueSession(user.userId, {
        ttlHours: Number(req.body?.ttlHours || 168),
        userAgent: req.headers['user-agent'] || '',
        ip: req.ip || ''
      });
      res.status(201).json({ user, session });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/auth/me', requireSession, async (req, res) => {
    const memberships = authStore ? await authStore.listMemberships(req.gtmSession.userId) : [];
    res.json({ user: req.gtmSession, memberships });
  });

  router.post('/auth/logout', requireSession, async (req, res) => {
    if (authStore) await authStore.revokeSession(req.gtmSession.sessionId, req.gtmSession.userId);
    res.json({ ok: true });
  });

  router.post('/workspaces', requireSession, async (req, res) => {
    try {
      const workspace = await store.createWorkspace({
        name: req.body?.name,
        plan: req.body?.plan || 'solo'
      });
      if (authStore && req.gtmSession?.userId) await authStore.ensureMembership(req.gtmSession.userId, workspace.workspaceId, 'owner');
      res.status(201).json({ workspace });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.use('/workspaces/:workspaceId', requireViewer);

  router.get('/workspaces/:workspaceId', async (req, res) => {
    const workspace = await store.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'workspace not found' });
    const profile = await store.getProfile(req.params.workspaceId);
    res.json({ workspace, profile });
  });

  router.put('/workspaces/:workspaceId/profile', requireOperator, async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const profile = await store.saveProfile(req.params.workspaceId, req.body || {});
      res.json({ profile });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/workspaces/:workspaceId/campaigns', async (req, res) => {
    const workspace = await store.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'workspace not found' });
    const campaigns = await store.listCampaigns(req.params.workspaceId);
    res.json({ campaigns });
  });

  router.post('/workspaces/:workspaceId/campaigns', requireOperator, async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const campaign = await store.createCampaign(req.params.workspaceId, req.body || {});
      res.status(201).json({ campaign });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });


  router.post('/workspaces/:workspaceId/campaigns/plan', async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const profile = await store.getProfile(req.params.workspaceId) || {};
      const plan = planCampaign(req.body?.prompt, profile);
      res.json({ plan });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/campaigns/from-prompt', requireOperator, async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const profile = await store.getProfile(req.params.workspaceId) || {};
      const plan = planCampaign(req.body?.prompt, profile);
      const campaign = await store.createCampaign(req.params.workspaceId, plan);
      res.status(201).json({ plan, campaign });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });


  router.get('/workspaces/:workspaceId/campaigns/:campaignId/control-room', async (req, res) => {
    const room = await store.getCampaignControlRoom(req.params.workspaceId, req.params.campaignId);
    if (!room) return res.status(404).json({ error: 'campaign not found' });
    res.json(room);
  });

  router.post('/workspaces/:workspaceId/campaigns/:campaignId/prospects', requireOperator, async (req, res) => {
    try {
      const prospect = await store.addProspect(req.params.workspaceId, req.params.campaignId, req.body || {});
      if (!prospect) return res.status(404).json({ error: 'campaign not found' });
      res.status(201).json({ prospect });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/prospects/:prospectId/reply', requireOperator, async (req, res) => {
    const result = await store.recordReply(req.params.workspaceId, req.params.prospectId, req.body?.classification || 'interested');
    if (!result) return res.status(404).json({ error: 'prospect not found' });
    res.json(result);
  });


  router.get('/workspaces/:workspaceId/inbox', async (req, res) => {
    const threads = await store.listInbox(req.params.workspaceId);
    res.json({ threads });
  });

  router.post('/workspaces/:workspaceId/threads/:threadId/draft-reply', requireOperator, async (req, res) => {
    try {
      const classification = req.body?.classification || classifyReply(req.body?.inboundText || '');
      const body = draftReply({
        classification,
        contactName: req.body?.contactName || '',
        offerName: req.body?.offerName || '',
        bookingUrl: req.body?.bookingUrl || ''
      });
      const message = await store.addInboxMessage(req.params.workspaceId, req.params.threadId, {
        direction: 'draft', sender: 'LionOS', body, status: 'draft'
      });
      if (!message) return res.status(404).json({ error: 'thread not found' });
      res.json({ classification, message });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/threads/:threadId/book-meeting', requireOperator, async (req, res) => {
    const meeting = await store.bookMeeting(req.params.workspaceId, req.params.threadId, req.body || {});
    if (!meeting) return res.status(404).json({ error: 'thread not found' });
    res.status(201).json({ meeting });
  });


  router.get('/workspaces/:workspaceId/integrations/readiness', async (req, res) => {
    const workspace = await store.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'workspace not found' });
    res.json({ providers: integrationReadiness() });
  });


  router.get('/workspaces/:workspaceId/agents', async (req, res) => {
    const agents = await store.listAgents(req.params.workspaceId);
    res.json({ agents });
  });

  router.get('/workspaces/:workspaceId/usage', async (req, res) => {
    const usage = await store.getUsageSummary(req.params.workspaceId);
    if (!usage) return res.status(404).json({ error: 'workspace not found' });
    res.json({ usage });
  });

  router.post('/workspaces/:workspaceId/usage/charge', requireAdmin, async (req, res) => {
    try {
      const priced = priceAction(req.body?.actionKey, Number(req.body?.quantity || 1));
      if (!priced.purse) return res.status(400).json({ error: 'unknown metered action' });
      const row = await store.recordUsage(req.params.workspaceId, {
        ...priced,
        actionKey: req.body.actionKey,
        idempotencyKey: req.body?.idempotencyKey,
        providerCostCents: req.body?.providerCostCents,
        entityType: req.body?.entityType,
        entityId: req.body?.entityId,
        metadata: req.body?.metadata || {}
      });
      if (!row) return res.status(404).json({ error: 'workspace not found' });
      const usage = await store.getUsageSummary(req.params.workspaceId);
      res.status(201).json({ charge: row, usage });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/workspaces/:workspaceId/insights', async (req, res) => {
    const insights = await store.getWorkspaceInsights(req.params.workspaceId);
    if (!insights) return res.status(404).json({ error: 'workspace not found' });
    res.json({ insights });
  });

  router.post('/workspaces/:workspaceId/campaigns/:campaignId/source/preview', async (req, res) => {
    try {
      const campaign = await store.getCampaign(req.params.workspaceId, req.params.campaignId);
      if (!campaign) return res.status(404).json({ error: 'campaign not found' });
      const provider = new CsvSourceProvider(Array.isArray(req.body?.candidates) ? req.body.candidates : []);
      const accepted = await runSourcing({
        provider,
        icp: campaign.icp || {},
        highPrecision: Boolean(req.body?.highPrecision)
      });
      res.json({
        found: Array.isArray(req.body?.candidates) ? req.body.candidates.length : 0,
        accepted: accepted.length,
        candidates: accepted
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });


  router.get('/workspaces/:workspaceId/sources/readiness', async (req, res) => {
    const workspace = await store.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'workspace not found' });
    res.json({ providers: { apollo: Boolean(process.env.APOLLO_API_KEY) } });
  });

  router.post('/workspaces/:workspaceId/campaigns/:campaignId/source/apollo-preview', requireOperator, async (req, res) => {
    try {
      const campaign = await store.getCampaign(req.params.workspaceId, req.params.campaignId);
      if (!campaign) return res.status(404).json({ error: 'campaign not found' });
      const provider = new ApolloProvider({ apiKey: process.env.APOLLO_API_KEY });
      const candidates = await provider.search({
        icp: {
          ...(campaign.icp || {}),
          titles: req.body?.titles || campaign.icp?.titles || [],
          seniorities: req.body?.seniorities || campaign.icp?.seniorities || [],
          domains: req.body?.domains || [],
          excludeDomains: req.body?.excludeDomains || [],
          keywords: req.body?.keywords || '',
          emailStatus: req.body?.emailStatus || 'verified'
        },
        page: Number(req.body?.page || 1),
        perPage: Math.min(100, Math.max(1, Number(req.body?.perPage || 25)))
      });
      res.json({ provider: 'apollo', count: candidates.length, candidates });
    } catch (error) {
      res.status(error.code === 'APOLLO_NOT_CONFIGURED' ? 503 : 400).json({ error: error.message });
    }
  });


  router.post('/workspaces/:workspaceId/send/evaluate', requireOperator, async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const result = evaluateSend(req.body || {});
      res.json({ result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/csv-import/preview', requireOperator, async (req, res) => {
    try {
      const workspace = await store.getWorkspace(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'workspace not found' });
      const result = importRows(
        Array.isArray(req.body?.rows) ? req.body.rows : [],
        req.body?.mapping || {},
        { skipFitGate: req.body?.skipFitGate !== false }
      );
      res.json({ result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createGtmPlatformRouter };
