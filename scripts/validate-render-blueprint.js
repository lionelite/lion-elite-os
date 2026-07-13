'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const blueprintPath = path.join(root, 'render.yaml');

function fail(message) {
  console.error(`Render blueprint validation failed: ${message}`);
  process.exitCode = 1;
}

if (!fs.existsSync(blueprintPath)) {
  fail('render.yaml is missing.');
  process.exit();
}

const blueprint = fs.readFileSync(blueprintPath, 'utf8');
const requiredSnippets = [
  'healthCheckPath: /health',
  'startCommand: npm start',
  'startCommand: node outreach-server-postgres.js',
  'startCommand: npm run worker:outreach',
  'startCommand: node scripts/operations-monitor.js',
  'startCommand: node scripts/cron-scheduler.js discovery',
  'startCommand: node scripts/cron-scheduler.js staleData',
  'startCommand: node scripts/cron-scheduler.js followups',
  'startCommand: node scripts/cron-scheduler.js analytics',
  'startCommand: node scripts/cron-scheduler.js cleanup'
];

for (const snippet of requiredSnippets) {
  if (!blueprint.includes(snippet)) fail(`missing required configuration: ${snippet}`);
}

const requiredFiles = [
  'server.js',
  'outreach-server-postgres.js',
  'workers/outreach-worker.js',
  'scripts/operations-monitor.js',
  'scripts/cron-scheduler.js',
  'scripts/migrate.js',
  'lib/job-queues.js'
];

for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) fail(`referenced file does not exist: ${relativePath}`);
}

const cronScheduler = fs.readFileSync(path.join(root, 'scripts/cron-scheduler.js'), 'utf8');
if (!cronScheduler.includes("require('../lib/job-queues')")) {
  fail('cron scheduler must import ../lib/job-queues.');
}

if (!process.exitCode) {
  console.log('Render blueprint validation passed.');
}
