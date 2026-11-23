#!/usr/bin/env node
'use strict';

// Terminal kill switch for automated outreach sending.
//
//   node scripts/outreach-kill-switch.js status
//   node scripts/outreach-kill-switch.js halt "reason for halting"
//   node scripts/outreach-kill-switch.js resume
//
// Requires REDIS_URL (same Redis the outreach worker uses). Takes effect
// on the very next job — no redeploy. For a hard stop that survives Redis
// itself being wiped, also set OUTREACH_SEND_ENABLED=false in Render.

const { halt, resume, status } = require('../lib/kill-switch');
const { closeRedis } = require('../lib/redis');

async function main() {
  const [, , command, ...rest] = process.argv;
  const by = `cli:${process.env.USER || 'operator'}`;

  if (command === 'status') {
    console.log(JSON.stringify(await status(), null, 2));
  } else if (command === 'halt') {
    const reason = rest.join(' ').trim() || 'manual halt via CLI';
    console.log(JSON.stringify(await halt(reason, by), null, 2));
    console.log('Sending HALTED. Pending items stay queued; nothing dispatches until resume.');
  } else if (command === 'resume') {
    console.log(JSON.stringify(await resume(by), null, 2));
    console.log('Sending RESUMED. The follow-ups scheduler will dispatch queued items.');
  } else {
    console.error('Usage: node scripts/outreach-kill-switch.js status|halt [reason]|resume');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(`kill-switch error: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeRedis().catch(() => {}));
