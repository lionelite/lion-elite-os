'use strict';

const express = require('express');
const { planCampaign } = require('../lib/platform/campaign-planner');
const { classifyReply, draftReply } = require('../lib/platform/reply-assistant');
const { integrationReadiness } = require('../lib/platform/integrations');
const { priceAction } = require('../lib/platform/usage-meter');
const { CsvSourceProvider, runSourcing } = require('../lib/platform/sourcing');
const { ApolloProvider } = require('../lib/platform/sources/apollo');

function createGtmPlatformRouter({ store }) {
  const router = express.Router();

  router.post('/workspaces', async (req, res) => {
    try {
      const workspace = await store.createWorkspace({
        name: req.body?.name,
        plan: req.body?.plan || 'solo'
      });
      res.status(201).json({ workspace });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/workspaces/:workspaceId', async (req, res) => {
    const workspace = await store.getWorkspace(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'workspace not found' });
    const profile = await store.getProfile(req.params.workspaceId);
    res.json({ workspace, profile });
  });

  router.put('/workspaces/:workspaceId/profile', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/campaigns', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/campaigns/from-prompt', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/campaigns/:campaignId/prospects', async (req, res) => {
    try {
      const prospect = await store.addProspect(req.params.workspaceId, req.params.campaignId, req.body || {});
      if (!prospect) return res.status(404).json({ error: 'campaign not found' });
      res.status(201).json({ prospect });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/prospects/:prospectId/reply', async (req, res) => {
    const result = await store.recordReply(req.params.workspaceId, req.params.prospectId, req.body?.classification || 'interested');
    if (!result) return res.status(404).json({ error: 'prospect not found' });
    res.json(result);
  });


  router.get('/workspaces/:workspaceId/inbox', async (req, res) => {
    const threads = await store.listInbox(req.params.workspaceId);
    res.json({ threads });
  });

  router.post('/workspaces/:workspaceId/threads/:threadId/draft-reply', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/threads/:threadId/book-meeting', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/usage/charge', async (req, res) => {
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

  router.post('/workspaces/:workspaceId/campaigns/:campaignId/source/apollo-preview', async (req, res) => {
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

  return router;
}

module.exports = { createGtmPlatformRouter };
