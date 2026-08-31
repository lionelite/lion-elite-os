'use strict';

const crypto = require('crypto');
const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 10000);
const maxBody = process.env.PARTNER_APPLICATION_MAX_BODY || '256kb';

app.use(express.json({ limit: maxBody }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanString(value, max = 500) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function normalizeApplication(body = {}) {
  const program = cleanString(body.program, 32).toLowerCase();
  if (!['affiliate', 'wholesale'].includes(program)) {
    const error = new Error('Please choose affiliate or wholesale.');
    error.status = 400;
    throw error;
  }

  const email = cleanString(body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }

  const firstName = cleanString(body.firstName, 80);
  const lastName = cleanString(body.lastName, 80);
  const organization = cleanString(body.organization, 160) || [firstName, lastName].filter(Boolean).join(' ');
  if (!organization) {
    const error = new Error('Please enter your name or organization.');
    error.status = 400;
    throw error;
  }

  return {
    type: `${program}_application`,
    program,
    firstName,
    lastName,
    organization,
    email,
    phone: cleanString(body.phone, 40),
    country: cleanString(body.country, 100),
    website: cleanString(body.website, 300),
    profileUrl: cleanString(body.profileUrl, 300),
    audienceEstimate: cleanString(body.audienceEstimate, 100),
    territory: cleanString(body.territory, 160),
    businessType: cleanString(body.businessType, 120),
    monthlyVolume: cleanString(body.monthlyVolume, 120),
    experience: cleanString(body.experience, 1500),
    goals: cleanString(body.goals, 1500),
    referralSource: cleanString(body.referralSource, 200),
    campaign: program === 'wholesale' ? 'wholesale_applications' : 'affiliate_applications',
    submittedAt: new Date().toISOString()
  };
}

async function forwardApplication(application) {
  const gatewayUrl = cleanString(process.env.INTEGRATION_GATEWAY_URL, 500).replace(/\/$/, '');
  const secret = process.env.AFFILIATE_WEBHOOK_SECRET;
  if (!gatewayUrl || !secret) {
    const error = new Error('Partner application intake is not configured yet.');
    error.status = 503;
    throw error;
  }

  const body = JSON.stringify(application);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const eventId = crypto.randomUUID();
  const response = await fetch(`${gatewayUrl}/webhooks/affiliate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-lion-signature': signature,
      'x-lion-event-type': application.type,
      'x-lion-event-id': eventId
    },
    body,
    signal: AbortSignal.timeout(15000)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Application intake failed.');
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  return { eventId, gateway: result };
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'lion-elite-partner-applications',
    configured: Boolean(process.env.INTEGRATION_GATEWAY_URL && process.env.AFFILIATE_WEBHOOK_SECRET)
  });
});

app.get('/partners', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'partners.html'));
});

app.post('/api/partner-applications', async (req, res) => {
  try {
    const application = normalizeApplication(req.body);
    const accepted = await forwardApplication(application);
    res.status(202).json({
      accepted: true,
      applicationType: application.program,
      eventId: accepted.eventId,
      message: 'Application received. Our team will review it and follow up by email.'
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unable to submit application.' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'partners.html'));
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Lion Elite partner application funnel running on port ${port}`);
  });
}

module.exports = { app, normalizeApplication, forwardApplication };
