'use strict';

const express = require('express');
const {
  createBusinessFingerprint,
  scoreQualification,
  validateProspect,
  authorizeOutreach
} = require('./lib/outreach-validation');

const app = express();
const port = process.env.OUTREACH_PORT || 3001;

app.use(express.json({ limit: '1mb' }));

const defaultPolicy = Object.freeze({
  ruleVersion: '1.0.0',
  minimumIdentityConfidence: 0.8,
  minimumQualificationScore: 70,
  minimumPersonalizationScore: 75,
  minimumEvidenceCoverage: 0.9,
  maxDataAgeDays: 30,
  maxContactsPerWindow: 3,
  approvedChannels: ['email', 'sms', 'linkedin', 'manual_call'],
  requiredBusinessFields: ['name', 'domain']
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lion-elite-outreach-validation',
    ruleVersion: defaultPolicy.ruleVersion,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/outreach/fingerprint', (req, res) => {
  res.json({ fingerprint: createBusinessFingerprint(req.body?.business || req.body || {}) });
});

app.post('/api/outreach/score', (req, res) => {
  const { signals = {}, weights = {} } = req.body || {};
  res.json({ score: scoreQualification(signals, weights) });
});

app.post('/api/outreach/validate', (req, res) => {
  const prospect = req.body?.prospect || {};
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };
  const validation = validateProspect(prospect, policy);
  res.status(validation.passed ? 200 : 422).json({ validation });
});

app.post('/api/outreach/authorize', (req, res) => {
  const prospect = req.body?.prospect || {};
  const policy = { ...defaultPolicy, ...(req.body?.policy || {}) };

  try {
    const authorization = authorizeOutreach(prospect, policy);
    res.json({ authorization });
  } catch (error) {
    res.status(422).json({
      error: error.code || 'OUTREACH_BLOCKED',
      message: error.message,
      validation: error.validation
    });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'The outreach service could not complete the request.' });
});

app.listen(port, () => {
  console.log(`Lion Elite outreach validation service running on port ${port}`);
});

module.exports = { app, defaultPolicy };
