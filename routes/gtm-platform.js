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
const { OAuthStore } = require('../lib/platform/oauth-store');
const { ResendProvisioner } = require('../lib/platform/senders/resend');
const db = require('../lib/database');
const { beginGoogleOAuth, exchangeGoogleOAuth } = require('../lib/platform/oauth/google');
const { productionReadiness } = require('../lib/platform/readiness');
const { PLANS, ADDONS, CREDIT_PACKS, getPack } = require('../lib/platform/commercial-catalog');
const { buildOnboardingPreview } = require('../lib/platform/fast-onboarding');
const { runtimeJobCatalog } = require('../lib/platform/runtime-jobs');
const { allowedTools, assertNoSendTools } = require('../lib/platform/mcp-tools');
const { assessSenderHealth } = require('../lib/platform/sender-health');
const { evaluateBudget } = require('../lib/platform/budget-policy');
const { encrypt } = require('../lib/platform/security/crypto-vault');

function createGtmPlatformRouter({ store, authStore }) {
  const router = express.Router();
  const oauthStore = new OAuthStore();
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



  router.post('/internal/oauth/store', async (req, res) => {
    try {
      const expected = String(process.env.GTM_OAUTH_CALLBACK_SECRET || '');
      const provided = String(req.headers['x-gtm-oauth-callback-secret'] || '');
      if (!expected || provided !== expected) return res.status(401).json({ error: 'oauth callback denied' });
      const { workspaceId, provider, externalAccountId, accessToken, refreshToken, tokenExpiresAt, scopes, metadata } = req.body || {};
      if (!workspaceId || !provider || !accessToken) return res.status(400).json({ error: 'workspaceId, provider, and accessToken are required' });
      const credential = await oauthStore.save(workspaceId, {
        provider, externalAccountId: externalAccountId || null, accessToken,
        refreshToken: refreshToken || null, tokenExpiresAt: tokenExpiresAt || null,
        scopes: Array.isArray(scopes) ? scopes : [], metadata: metadata || {}
      });
      res.status(201).json({ credential });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
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
      if (!req.body?.idempotencyKey) return res.status(400).json({ error: 'idempotencyKey is required' });

      const before = await store.getUsageSummary(req.params.workspaceId);
      if (!before) return res.status(404).json({ error: 'workspace not found' });
      const policy = await db.query(
        `SELECT overage_enabled AS "overageEnabled" FROM gtm_workspaces WHERE workspace_id=$1`,
        [req.params.workspaceId]
      );
      const overageEnabled = Boolean(policy.rows[0]?.overageEnabled);
      const purse = before[priced.purse];
      const projectedUsed = Number(purse.used || 0) + Number(priced.credits || 0);
      if (!overageEnabled && Number(purse.allowance || 0) > 0 && projectedUsed > Number(purse.allowance)) {
        const periodKey = new Date().toISOString().slice(0,7);
        await db.query(
          `INSERT INTO gtm_usage_incidents (workspace_id,purse,level,percent_used,balance_remaining,period_key)
           VALUES ($1,$2,'hard_stop',100,0,$3)
           ON CONFLICT (workspace_id,purse,level,period_key) DO NOTHING`,
          [req.params.workspaceId,priced.purse,periodKey]
        );
        return res.status(402).json({ error: 'credit allowance exhausted', purse: priced.purse, usage: before });
      }

      const row = await store.recordUsage(req.params.workspaceId, {
        ...priced,
        actionKey: req.body.actionKey,
        idempotencyKey: req.body.idempotencyKey,
        providerCostCents: req.body?.providerCostCents,
        entityType: req.body?.entityType,
        entityId: req.body?.entityId,
        metadata: req.body?.metadata || {}
      });
      const usage = await store.getUsageSummary(req.params.workspaceId);
      const budget = evaluateBudget(usage,80);
      const periodKey = new Date().toISOString().slice(0,7);
      for (const incident of budget.incidents) {
        await db.query(
          `INSERT INTO gtm_usage_incidents (workspace_id,purse,level,percent_used,balance_remaining,period_key)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (workspace_id,purse,level,period_key) DO NOTHING`,
          [req.params.workspaceId,incident.purse,incident.level,incident.percentUsed,incident.balanceRemaining,periodKey]
        );
      }
      res.status(201).json({ charge: row, usage, budget, overageEnabled });
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


  router.get('/workspaces/:workspaceId/oauth', async (req, res) => {
    try {
      const credentials = await oauthStore.listMetadata(req.params.workspaceId);
      res.json({ credentials });
    } catch (error) {
      res.status(500).json({ error: 'oauth metadata unavailable' });
    }
  });

  router.get('/workspaces/:workspaceId/senders', async (req, res) => {
    try {
      const [domains, requests] = await Promise.all([
        db.query(`SELECT sending_domain_id AS "sendingDomainId",domain,status,provider,verified_at AS "verifiedAt",created_at AS "createdAt"
          FROM gtm_sending_domains WHERE workspace_id=$1 ORDER BY created_at DESC`,[req.params.workspaceId]),
        db.query(`SELECT provisioning_request_id AS "provisioningRequestId",provider,domain,sender_local_part AS "senderLocalPart",status,
          dns_requirements AS "dnsRequirements",external_domain_id AS "externalDomainId",external_sender_id AS "externalSenderId",
          last_error AS "lastError",created_at AS "createdAt"
          FROM gtm_sender_provisioning_requests WHERE workspace_id=$1 ORDER BY created_at DESC`,[req.params.workspaceId])
      ]);
      res.json({ domains: domains.rows, provisioningRequests: requests.rows });
    } catch (error) {
      res.status(500).json({ error: 'sender provisioning state unavailable' });
    }
  });

  router.post('/workspaces/:workspaceId/senders/resend/provision', requireAdmin, async (req, res) => {
    try {
      const domain = String(req.body?.domain || '').trim().toLowerCase();
      const senderLocalPart = String(req.body?.senderLocalPart || 'hello').trim().toLowerCase();
      if (!domain) return res.status(400).json({ error: 'domain is required' });
      const provider = new ResendProvisioner({ apiKey: process.env.RESEND_API_KEY });
      const created = await provider.createDomain(domain);
      const dnsRequirements = created.records || [];
      const request = await db.query(`INSERT INTO gtm_sender_provisioning_requests
        (workspace_id,provider,domain,sender_local_part,status,dns_requirements,external_domain_id)
        VALUES ($1,'resend',$2,$3,'dns_pending',$4,$5)
        RETURNING provisioning_request_id AS "provisioningRequestId",provider,domain,sender_local_part AS "senderLocalPart",status,dns_requirements AS "dnsRequirements",external_domain_id AS "externalDomainId"`,
        [req.params.workspaceId,domain,senderLocalPart,dnsRequirements,created.id || null]);
      await db.query(`INSERT INTO gtm_sending_domains (workspace_id,domain,status,provider)
        VALUES ($1,$2,'pending','resend')
        ON CONFLICT (workspace_id,domain) DO UPDATE SET provider='resend',updated_at=now()`,
        [req.params.workspaceId,domain]);
      res.status(201).json({ provider: 'resend', domain: created, provisioning: request.rows[0] });
    } catch (error) {
      res.status(error.code === 'RESEND_NOT_CONFIGURED' ? 503 : 400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/senders/resend/:requestId/verify', requireAdmin, async (req, res) => {
    try {
      const found = await db.query(`SELECT provisioning_request_id AS "provisioningRequestId",domain,external_domain_id AS "externalDomainId"
        FROM gtm_sender_provisioning_requests WHERE workspace_id=$1 AND provisioning_request_id=$2 AND provider='resend'`,
        [req.params.workspaceId,req.params.requestId]);
      const row = found.rows[0];
      if (!row) return res.status(404).json({ error: 'provisioning request not found' });
      if (!row.externalDomainId) return res.status(409).json({ error: 'external domain id missing' });
      const provider = new ResendProvisioner({ apiKey: process.env.RESEND_API_KEY });
      await provider.verifyDomain(row.externalDomainId);
      const state = await provider.getDomain(row.externalDomainId);
      const verified = String(state.status || '').toLowerCase() === 'verified';
      await db.query(`UPDATE gtm_sender_provisioning_requests SET status=$3,updated_at=now(),last_error=NULL WHERE workspace_id=$1 AND provisioning_request_id=$2`,
        [req.params.workspaceId,req.params.requestId,verified ? 'provisioned' : 'verifying']);
      if (verified) {
        await db.query(`UPDATE gtm_sending_domains SET status='verified',verified_at=now(),updated_at=now() WHERE workspace_id=$1 AND domain=$2`,
          [req.params.workspaceId,row.domain]);
        await db.query(
          `INSERT INTO gtm_connector_health (workspace_id,provider,connection_key,status,verified_at,last_success_at,metadata)
           VALUES ($1,'resend',$2,'connected',now(),now(),$3)
           ON CONFLICT (workspace_id,provider,connection_key) DO UPDATE SET status='connected',verified_at=now(),last_success_at=now(),last_error=NULL,metadata=EXCLUDED.metadata,updated_at=now()`,
          [req.params.workspaceId,row.domain,{ domain: row.domain }]
        );
      }
      res.json({ provider: 'resend', verified, domain: state });
    } catch (error) {
      res.status(error.code === 'RESEND_NOT_CONFIGURED' ? 503 : 400).json({ error: error.message });
    }
  });


  router.get('/production/readiness', async (_req, res) => {
    res.json({ production: productionReadiness() });
  });

  router.get('/workspaces/:workspaceId/oauth/google/connect', requireAdmin, async (req, res) => {
    try {
      const result = await beginGoogleOAuth({
        workspaceId: req.params.workspaceId,
        userId: req.gtmSession.userId
      });
      res.json(result);
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  router.get('/oauth/google/callback', async (req, res) => {
    try {
      const result = await exchangeGoogleOAuth({ state: req.query.state, code: req.query.code });
      const expiresAt = result.tokens.expires_in ? new Date(Date.now() + Number(result.tokens.expires_in) * 1000).toISOString() : null;
      await oauthStore.save(result.workspaceId, {
        provider: 'gmail',
        externalAccountId: null,
        accessToken: result.tokens.access_token,
        refreshToken: result.tokens.refresh_token || null,
        tokenExpiresAt: expiresAt,
        scopes: String(result.tokens.scope || '').split(/\s+/).filter(Boolean),
        metadata: { tokenType: result.tokens.token_type || 'Bearer', connectedByUserId: result.userId }
      });
      await db.query(
        `INSERT INTO gtm_connector_health (workspace_id,provider,connection_key,status,verified_at,last_success_at,metadata)
         VALUES ($1,'google','default','connected',now(),now(),$2)
         ON CONFLICT (workspace_id,provider,connection_key) DO UPDATE SET status='connected',verified_at=now(),last_success_at=now(),last_error=NULL,metadata=EXCLUDED.metadata,updated_at=now()`,
        [result.workspaceId,{ scopes: String(result.tokens.scope || '').split(/\s+/).filter(Boolean) }]
      );
      res.redirect('/production-setup/?workspaceId=' + encodeURIComponent(result.workspaceId) + '&google=connected');
    } catch (error) {
      res.status(400).send('Google OAuth failed: ' + String(error.message || error));
    }
  });


  router.get('/workspaces/:workspaceId/usage/incidents', async (req, res) => {
    const r = await db.query(
      `SELECT usage_incident_id AS "usageIncidentId",purse,level,percent_used AS "percentUsed",
        balance_remaining AS "balanceRemaining",period_key AS "periodKey",acknowledged_at AS "acknowledgedAt",
        created_at AS "createdAt"
       FROM gtm_usage_incidents WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.workspaceId]
    );
    res.json({ incidents: r.rows });
  });

  router.get('/workspaces/:workspaceId/connectors/health', async (req, res) => {
    const r = await db.query(
      `SELECT provider,connection_key AS "connectionKey",status,verified_at AS "verifiedAt",
        last_success_at AS "lastSuccessAt",last_failure_at AS "lastFailureAt",last_error AS "lastError",metadata
       FROM gtm_connector_health WHERE workspace_id=$1 ORDER BY provider,connection_key`,
      [req.params.workspaceId]
    );
    res.json({ connectors: r.rows });
  });

  router.post('/workspaces/:workspaceId/webhooks', requireAdmin, async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      if (!/^https:\/\//i.test(url)) return res.status(400).json({ error: 'HTTPS webhook URL required' });
      const secret = String(req.body?.signingSecret || '').trim();
      if (!secret) return res.status(400).json({ error: 'signingSecret is required' });
      const eventTypes = Array.isArray(req.body?.eventTypes) ? req.body.eventTypes : [];
      const r = await db.query(
        `INSERT INTO gtm_webhook_endpoints (workspace_id,url,signing_secret_ciphertext,event_types)
         VALUES ($1,$2,$3,$4)
         RETURNING webhook_endpoint_id AS "webhookEndpointId",url,enabled,event_types AS "eventTypes",created_at AS "createdAt"`,
        [req.params.workspaceId,url,encrypt(secret),eventTypes]
      );
      res.status(201).json({ webhook: r.rows[0] });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/workspaces/:workspaceId/webhooks/:webhookEndpointId/test', requireAdmin, async (req, res) => {
    try {
      const exists = await db.query(
        `SELECT webhook_endpoint_id FROM gtm_webhook_endpoints WHERE workspace_id=$1 AND webhook_endpoint_id=$2 AND enabled=true`,
        [req.params.workspaceId,req.params.webhookEndpointId]
      );
      if (!exists.rows[0]) return res.status(404).json({ error: 'webhook endpoint not found' });
      const payload = { type: 'webhook.test', workspaceId: req.params.workspaceId, at: new Date().toISOString() };
      const idempotencyKey = 'webhook-test:' + req.params.webhookEndpointId + ':' + Date.now();
      const job = await db.query(
        `INSERT INTO gtm_delivery_jobs (workspace_id,destination,event_type,payload,idempotency_key)
         VALUES ($1,$2,'webhook.test',$3,$4)
         RETURNING delivery_job_id AS "deliveryJobId",status,next_attempt_at AS "nextAttemptAt"`,
        [req.params.workspaceId,'webhook:'+req.params.webhookEndpointId,payload,idempotencyKey]
      );
      res.status(202).json({ delivery: job.rows[0] });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });


  router.get('/workspaces/:workspaceId/library', async (req, res) => {
    const [templates,audiences,sequences] = await Promise.all([
      db.query(`SELECT template_id AS "templateId",name,channel,subject,body,variables,updated_at AS "updatedAt" FROM gtm_templates WHERE workspace_id=$1 ORDER BY updated_at DESC`,[req.params.workspaceId]),
      db.query(`SELECT audience_id AS "audienceId",name,source,definition,estimated_size AS "estimatedSize",updated_at AS "updatedAt" FROM gtm_audiences WHERE workspace_id=$1 ORDER BY updated_at DESC`,[req.params.workspaceId]),
      db.query(`SELECT sequence_id AS "sequenceId",name,steps,stop_on_reply AS "stopOnReply",updated_at AS "updatedAt" FROM gtm_sequences WHERE workspace_id=$1 ORDER BY updated_at DESC`,[req.params.workspaceId])
    ]);
    res.json({templates:templates.rows,audiences:audiences.rows,sequences:sequences.rows});
  });

  router.post('/workspaces/:workspaceId/templates', requireOperator, async (req, res) => {
    try{
      const r=await db.query(`INSERT INTO gtm_templates (workspace_id,name,channel,subject,body,variables)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING template_id AS "templateId",name,channel,subject,body,variables`,
        [req.params.workspaceId,String(req.body?.name||'Untitled template'),String(req.body?.channel||'email'),String(req.body?.subject||''),String(req.body?.body||''),Array.isArray(req.body?.variables)?req.body.variables:[]]);
      res.status(201).json({template:r.rows[0]});
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.post('/workspaces/:workspaceId/audiences', requireOperator, async (req, res) => {
    try{
      const r=await db.query(`INSERT INTO gtm_audiences (workspace_id,name,source,definition,estimated_size)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING audience_id AS "audienceId",name,source,definition,estimated_size AS "estimatedSize"`,
        [req.params.workspaceId,String(req.body?.name||'Untitled audience'),String(req.body?.source||'dynamic'),req.body?.definition||{},req.body?.estimatedSize==null?null:Number(req.body.estimatedSize)]);
      res.status(201).json({audience:r.rows[0]});
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.post('/workspaces/:workspaceId/sequences', requireOperator, async (req, res) => {
    try{
      const r=await db.query(`INSERT INTO gtm_sequences (workspace_id,name,steps,stop_on_reply)
        VALUES ($1,$2,$3,$4)
        RETURNING sequence_id AS "sequenceId",name,steps,stop_on_reply AS "stopOnReply"`,
        [req.params.workspaceId,String(req.body?.name||'Untitled sequence'),Array.isArray(req.body?.steps)?req.body.steps:[],req.body?.stopOnReply!==false]);
      res.status(201).json({sequence:r.rows[0]});
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.get('/workspaces/:workspaceId/agent-settings', async (req, res) => {
    const r=await db.query(`SELECT agent_key AS "agentKey",display_label AS "displayLabel",prompt_override AS "promptOverride",model_tier AS "modelTier",cadence_seconds AS "cadenceSeconds",send_policy AS "sendPolicy",updated_at AS "updatedAt" FROM gtm_agent_settings WHERE workspace_id=$1 ORDER BY agent_key`,[req.params.workspaceId]);
    res.json({settings:r.rows});
  });

  router.put('/workspaces/:workspaceId/agent-settings/:agentKey', requireAdmin, async (req, res) => {
    const cadence=req.body?.cadenceSeconds==null?null:Math.max(60,Number(req.body.cadenceSeconds));
    const model=['economy','standard','premium'].includes(req.body?.modelTier)?req.body.modelTier:'standard';
    const sendPolicy=['supervised','autopilot'].includes(req.body?.sendPolicy)?req.body.sendPolicy:null;
    const r=await db.query(`INSERT INTO gtm_agent_settings (workspace_id,agent_key,display_label,prompt_override,model_tier,cadence_seconds,send_policy)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (workspace_id,agent_key) DO UPDATE SET display_label=EXCLUDED.display_label,prompt_override=EXCLUDED.prompt_override,model_tier=EXCLUDED.model_tier,cadence_seconds=EXCLUDED.cadence_seconds,send_policy=EXCLUDED.send_policy,updated_at=now()
      RETURNING agent_key AS "agentKey",display_label AS "displayLabel",prompt_override AS "promptOverride",model_tier AS "modelTier",cadence_seconds AS "cadenceSeconds",send_policy AS "sendPolicy"`,
      [req.params.workspaceId,req.params.agentKey,String(req.body?.displayLabel||''),String(req.body?.promptOverride||''),model,cadence,sendPolicy]);
    res.json({setting:r.rows[0]});
  });

  router.post('/workspaces/:workspaceId/agent-threads', requireOperator, async (req, res) => {
    const r=await db.query(`INSERT INTO gtm_agent_threads (workspace_id,user_id,title) VALUES ($1,$2,$3) RETURNING agent_thread_id AS "agentThreadId",title,created_at AS "createdAt"`,
      [req.params.workspaceId,req.gtmSession?.userId||null,String(req.body?.title||'Agent conversation')]);
    res.status(201).json({thread:r.rows[0]});
  });

  router.get('/workspaces/:workspaceId/agent-threads/:threadId', async (req, res) => {
    const [thread,turns]=await Promise.all([
      db.query(`SELECT agent_thread_id AS "agentThreadId",title,created_at AS "createdAt",updated_at AS "updatedAt" FROM gtm_agent_threads WHERE workspace_id=$1 AND agent_thread_id=$2`,[req.params.workspaceId,req.params.threadId]),
      db.query(`SELECT agent_turn_id AS "agentTurnId",role,content,tool_name AS "toolName",tool_payload AS "toolPayload",status,created_at AS "createdAt" FROM gtm_agent_turns WHERE workspace_id=$1 AND agent_thread_id=$2 ORDER BY created_at`,[req.params.workspaceId,req.params.threadId])
    ]);
    if(!thread.rows[0]) return res.status(404).json({error:'agent thread not found'});
    res.json({thread:thread.rows[0],turns:turns.rows});
  });

  router.post('/workspaces/:workspaceId/agent-threads/:threadId/turns', requireOperator, async (req, res) => {
    const r=await db.query(`INSERT INTO gtm_agent_turns (agent_thread_id,workspace_id,role,content,tool_name,tool_payload,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING agent_turn_id AS "agentTurnId",role,content,tool_name AS "toolName",tool_payload AS "toolPayload",status,created_at AS "createdAt"`,
      [req.params.threadId,req.params.workspaceId,String(req.body?.role||'user'),String(req.body?.content||''),req.body?.toolName||null,req.body?.toolPayload||null,String(req.body?.status||'completed')]);
    res.status(201).json({turn:r.rows[0]});
  });


  router.get('/commercial/catalog', (_req, res) => {
    res.json({ plans: PLANS, addOns: ADDONS, creditPacks: CREDIT_PACKS });
  });

  router.get('/workspaces/:workspaceId/usage/period', async (req, res) => {
    const period = String(req.query.period || new Date().toISOString().slice(0,7));
    if(!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({error:'period must be YYYY-MM'});
    const start = period + '-01T00:00:00Z';
    const end = new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),1)).toISOString();
    const [ledger,packs] = await Promise.all([
      db.query(`SELECT purse,action_key AS "actionKey",SUM(credits)::int AS credits,SUM(quantity)::int AS quantity,SUM(COALESCE(provider_cost_cents,0))::int AS "providerCostCents"
        FROM gtm_usage_ledger WHERE workspace_id=$1 AND occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz
        GROUP BY purse,action_key ORDER BY purse,credits DESC`,[req.params.workspaceId,start,end]),
      db.query(`SELECT purse,SUM(credits)::int AS credits,SUM(price_cents)::int AS "priceCents"
        FROM gtm_credit_pack_purchases WHERE workspace_id=$1 AND period_key=$2 AND status='paid' GROUP BY purse`,[req.params.workspaceId,period])
    ]);
    res.json({period,breakdown:ledger.rows,creditPacks:packs.rows});
  });

  router.get('/agency/report', requireSession, async (req, res) => {
    try{
      const memberships = await authStore.listMemberships(req.gtmSession.userId);
      const workspaceIds = memberships.filter(x=>['owner','admin'].includes(x.role)).map(x=>x.workspaceId);
      if(!workspaceIds.length) return res.json({workspaces:[],totals:{sourced:0,replied:0,booked:0}});
      const r=await db.query(`SELECT w.workspace_id AS "workspaceId",w.name,w.plan,
        COUNT(p.prospect_id)::int AS sourced,
        COUNT(p.prospect_id) FILTER (WHERE p.status IN ('replied','meeting','opportunity','won','lost'))::int AS replied,
        COUNT(p.prospect_id) FILTER (WHERE p.status IN ('meeting','opportunity','won','lost'))::int AS booked
        FROM gtm_workspaces w
        LEFT JOIN gtm_prospects p ON p.workspace_id=w.workspace_id
        WHERE w.workspace_id = ANY($1::uuid[])
        GROUP BY w.workspace_id,w.name,w.plan
        ORDER BY w.name`,[workspaceIds]);
      const totals=r.rows.reduce((a,x)=>({sourced:a.sourced+x.sourced,replied:a.replied+x.replied,booked:a.booked+x.booked}),{sourced:0,replied:0,booked:0});
      res.json({workspaces:r.rows,totals});
    }catch(error){res.status(500).json({error:'agency report unavailable'})}
  });

  router.post('/workspaces/:workspaceId/onboarding/preview', requireOperator, async (req, res) => {
    try{
      const profile = await store.getProfile(req.params.workspaceId) || {};
      const preview = buildOnboardingPreview({
        website:req.body?.website||profile.websiteUrl||'',
        companyName:req.body?.companyName||'',
        keywords:Array.isArray(req.body?.keywords)?req.body.keywords:[],
        channel:req.body?.channel||'email',
        profile
      });
      const r=await db.query(`INSERT INTO gtm_onboarding_previews (workspace_id,company,keywords,channels,preview)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING onboarding_preview_id AS "onboardingPreviewId",preview,created_at AS "createdAt"`,
        [req.params.workspaceId,preview.company,preview.keywords,preview.channels,preview]);
      res.status(201).json({preview:r.rows[0]});
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.post('/workspaces/:workspaceId/credit-packs/:packKey/purchase-intent', requireAdmin, async (req, res) => {
    const pack=getPack(req.params.packKey);
    if(!pack) return res.status(404).json({error:'credit pack not found'});
    const periodKey=new Date().toISOString().slice(0,7);
    const r=await db.query(`INSERT INTO gtm_credit_pack_purchases (workspace_id,pack_key,purse,credits,price_cents,period_key,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,(date_trunc('month',now())+interval '1 month'))
      RETURNING credit_pack_purchase_id AS "creditPackPurchaseId",pack_key AS "packKey",purse,credits,price_cents AS "priceCents",status,period_key AS "periodKey",expires_at AS "expiresAt"`,
      [req.params.workspaceId,pack.key,pack.purse,pack.credits,pack.priceCents,periodKey]);
    const priceEnv='GTM_STRIPE_PRICE_'+pack.key.toUpperCase().replace(/-/g,'_');
    res.status(201).json({
      purchase:r.rows[0],
      checkoutConfigured:Boolean(process.env.STRIPE_SECRET_KEY&&process.env[priceEnv]),
      stripePriceEnv:priceEnv
    });
  });

  return router;
}

module.exports = { createGtmPlatformRouter };
