'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCommand,
  extractJson,
  validatePlan,
  MAX_COMMAND_LENGTH
} = require('../lib/openai-executive-agent');

test('normalizeCommand requires a command and defaults to human approval', () => {
  assert.throws(() => normalizeCommand({}), /COMMAND_REQUIRED/);
  const result = normalizeCommand({ command: 'Build the client intelligence dashboard' });
  assert.equal(result.approvalMode, 'human-required');
  assert.deepEqual(result.brands, ['lion-elite-wellness', 'lion-elite-beauty']);
});

test('normalizeCommand rejects oversized commands', () => {
  assert.throws(
    () => normalizeCommand({ command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) }),
    /COMMAND_TOO_LARGE/
  );
});

test('extractJson supports strict and fenced JSON', () => {
  assert.deepEqual(extractJson('{"summary":"ok","actions":[]}'), { summary: 'ok', actions: [] });
  assert.deepEqual(
    extractJson('```json\n{"summary":"ok","actions":[]}\n```'),
    { summary: 'ok', actions: [] }
  );
});

test('validatePlan defaults every action to approval required', () => {
  const result = validatePlan({
    summary: 'Plan',
    priority: 'high',
    actions: [{ title: 'Draft campaign', type: 'draft' }]
  });

  assert.equal(result.actions[0].requiresApproval, true);
  assert.equal(result.actions[0].type, 'draft');
  assert.equal(result.priority, 'high');
});

test('validatePlan preserves an explicitly non-mutating auto-approved action', () => {
  const result = validatePlan({
    actions: [{ title: 'Analyze pipeline', type: 'analysis', requiresApproval: false }]
  });
  assert.equal(result.actions[0].requiresApproval, false);
});
