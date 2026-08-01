'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCommand, extractJson, validatePlan, MAX_COMMAND_LENGTH } = require('../lib/openai-executive-agent');
const { actionName, canExecute } = require('../lib/openai-action-dispatcher');

test('normalizeCommand requires a command and defaults to automatic live execution', () => {
  assert.throws(() => normalizeCommand({}), /COMMAND_REQUIRED/);
  const result = normalizeCommand({ command: 'Build the client intelligence dashboard' });
  assert.equal(result.approvalMode, 'automatic');
  assert.deepEqual(result.brands, ['lion-elite-wellness', 'lion-elite-beauty']);
});

test('normalizeCommand allows an explicit human approval mode', () => {
  const result = normalizeCommand({ command: 'Draft a campaign', approvalMode: 'human-required' });
  assert.equal(result.approvalMode, 'human-required');
});

test('normalizeCommand rejects oversized commands', () => {
  assert.throws(() => normalizeCommand({ command: 'x'.repeat(MAX_COMMAND_LENGTH + 1) }), /COMMAND_TOO_LARGE/);
});

test('extractJson supports strict and fenced JSON', () => {
  assert.deepEqual(extractJson('{"summary":"ok","actions":[]}'), { summary: 'ok', actions: [] });
  assert.deepEqual(extractJson('```json\n{"summary":"ok","actions":[]}\n```'), { summary: 'ok', actions: [] });
});

test('validatePlan defaults actions to executable unless approval is explicit', () => {
  const result = validatePlan({
    summary: 'Execute',
    priority: 'high',
    actions: [{ title: 'Generate brief', type: 'queue-job', payload: { action: 'morning-brief' } }]
  });
  assert.equal(result.actions[0].requiresApproval, false);
  assert.equal(result.priority, 'high');
});

test('allowlisted queue work executes automatically', () => {
  const action = { id: 'brief', type: 'queue-job', requiresApproval: false, payload: { action: 'morning-brief' } };
  assert.equal(actionName(action), 'morning-brief');
  assert.deepEqual(canExecute(action, 'automatic'), { allowed: true, reason: 'ALLOWLISTED' });
});

test('human-required mode holds actions marked for approval', () => {
  const action = { id: 'issue', type: 'github-issue', requiresApproval: true, payload: { action: 'create-github-issue' } };
  assert.deepEqual(canExecute(action, 'human-required'), { allowed: false, reason: 'HUMAN_APPROVAL_REQUIRED' });
});

test('sensitive and unknown actions remain blocked', () => {
  assert.equal(canExecute({ id: 'send', type: 'queue-job', payload: { action: 'send-email' } }, 'automatic').allowed, false);
  assert.equal(canExecute({ id: 'unknown', type: 'queue-job', payload: { action: 'unknown-task' } }, 'automatic').allowed, false);
});
