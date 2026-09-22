'use strict';

const express = require('express');
const { planCampaign } = require('../lib/platform/campaign-planner');
const { classifyReply, draftReply } = require('../lib/platform/reply-assistant');
const { integrationReadiness } = require('../lib/platform/integrations');

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

  return router;
}

module.exports = { createGtmPlatformRouter };
