#!/usr/bin/env node
'use strict';

// What is stalled, and what is actionable about it.
//
//   npm run ops:status
//
// Written because the honest answer to "why has nothing moved in eight days"
// needed an archaeology session across git log, the leads branch, GitHub
// Actions and DNS — and an answer that takes archaeology does not get looked
// up. This prints it in one command, deterministically, so a scheduled check
// has something to read rather than re-deriving the picture every time.
//
// Every check states a THRESHOLD and a verdict, not just a number. "12 runs,
// 0 leads" is data; "the lead engine has produced nothing in 12 consecutive
// runs, which is the signature of the pre-2026-09-24 bug" is a finding.
//
// No DB, no Redis, no secrets. Git plus the public GitHub API plus DNS.

const { execFileSync } = require('child_process');
const dns = require('dns').promises;

const REPO = 'lionelite/lion-elite-os';
const WORK_BRANCH = 'claude/ai-agency-business-model-6x1cpo';

// Thresholds. Named so a verdict can cite the rule it applied.
const STALE_MAIN_DAYS = 3;
const ZERO_HARVEST_RUNS = 3;
const UNMERGED_COMMITS_WARN = 1;
const RENDER_APEX_IPS = Object.freeze(['216.24.57.1', '216.24.57.251']);

const findings = [];

function add(level, area, finding, action) {
  findings.push({ level, area, finding, action });
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// Shells out to curl rather than using fetch.
//
// Node's native fetch (undici) does not honour HTTPS_PROXY, so inside this
// sandbox every call failed and the catch turned it into "no runs found" — the
// check reported absence when it had not been able to look. curl is
// proxy-aware and present both here and on a GitHub runner.
//
// `reachable` is returned separately from the data so a caller can tell "the
// API said there is nothing" from "I could not ask", which are opposite
// findings that look identical in a count.
function gh(path) {
  try {
    const body = execFileSync('curl', [
      '-sS', '--max-time', '20',
      '-H', 'accept: application/vnd.github+json',
      `https://api.github.com/repos/${REPO}${path}`
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    return { reachable: true, data: JSON.parse(body) };
  } catch (error) {
    const detail = (error.stderr && String(error.stderr).trim()) || error.message || 'unknown error';
    return { reachable: false, error: String(detail).split('\n')[0] };
  }
}

const daysSince = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

function checkMainActivity() {
  const last = git(['log', '-1', '--format=%cI|%s', 'origin/main']);
  if (!last) return add('warn', 'main', 'Could not read origin/main. Run `git fetch origin main`.', 'fetch');

  const [iso, subject] = last.split('|');
  const days = daysSince(iso);
  if (days >= STALE_MAIN_DAYS) {
    add('stalled', 'main',
      `No commit to main in ${days} days (last: "${subject.slice(0, 60)}"). Threshold is ${STALE_MAIN_DAYS}.`,
      'Development has stopped. If that is deliberate, nothing to do — but it means no fix reaches production.');
  } else {
    add('ok', 'main', `Last commit ${days} day(s) ago.`, null);
  }
}

function checkUnmergedWork() {
  const ahead = git(['rev-list', '--count', `origin/main..origin/${WORK_BRANCH}`]);
  if (!ahead) return add('warn', 'branch', `Could not compare ${WORK_BRANCH} to main.`, 'fetch both refs');

  const count = Number(ahead);
  if (count >= UNMERGED_COMMITS_WARN) {
    add('blocked', 'branch',
      `${count} commit(s) on ${WORK_BRANCH} are not on main.`,
      'Nothing on that branch affects production until it merges. This is the single highest-leverage unblock.');
  } else {
    add('ok', 'branch', 'Work branch is merged.', null);
  }
}

function checkHarvestYield() {
  // The leads branch records one commit per run with the new-lead count in the
  // subject, so the recent history is the yield curve.
  const log = git(['log', '--format=%s', '-20', 'origin/automation/leads']);
  if (!log) return add('warn', 'leads', 'Could not read origin/automation/leads.', 'git fetch origin automation/leads');

  const counts = log.split('\n')
    .map(line => line.match(/Harvest leads:\s*(\d+)\s*new/))
    .filter(Boolean)
    .map(match => Number(match[1]));

  if (!counts.length) return add('warn', 'leads', 'No harvest commits found.', null);

  let leadingZeros = 0;
  for (const count of counts) { if (count === 0) leadingZeros += 1; else break; }
  const total = counts.reduce((sum, n) => sum + n, 0);

  if (leadingZeros >= ZERO_HARVEST_RUNS) {
    add('stalled', 'leads',
      `${leadingZeros} consecutive runs produced 0 new leads (${total} across the last ${counts.length}).`,
      'This is the signature of the pre-fix harvest: a single Overpass union over three exhausted Ohio boxes. The fix is on the work branch and is not in main.');
  } else {
    add('ok', 'leads', `${total} new leads across the last ${counts.length} runs.`, null);
  }
}

function checkCi() {
  // The branch name contains a slash, so it goes in unencoded —
  // encodeURIComponent turns it into %2F, which the API does not match.
  const result = gh(`/actions/workflows/ci-render.yml/runs?branch=${WORK_BRANCH}&per_page=1`);

  // "Could not ask" and "the answer is none" are opposite findings that look
  // identical in a count, so they are reported separately.
  if (!result.reachable) {
    return add('warn', 'ci', `Could not reach the GitHub API (${result.error}). CI state is unknown, not absent.`, null);
  }

  const run = (result.data.workflow_runs || [])[0];
  if (!run) return add('warn', 'ci', 'The API returned no CI run for this branch.', 'Dispatch ci-render.yml against it.');

  if (run.conclusion === 'success') add('ok', 'ci', `CI green on ${run.head_sha.slice(0, 7)}.`, null);
  else add('blocked', 'ci', `CI is ${run.conclusion || run.status} on ${run.head_sha.slice(0, 7)}.`, 'Fix before merging.');
}

async function checkBuildPipelineDns() {
  // The launch checklist's first external switch is attaching the domain to
  // Render. DNS is the one part of that checklist verifiable from here, and a
  // registrar parking record is indistinguishable from "done" in a dashboard
  // screenshot, so check the record rather than trusting the checklist.
  let addresses;
  try {
    addresses = await dns.resolve4('buildpipeline.online');
  } catch (error) {
    return add('blocked', 'buildpipeline', `buildpipeline.online does not resolve (${error.code}).`, 'The domain is not pointed anywhere yet.');
  }

  const onRender = addresses.some(ip => RENDER_APEX_IPS.includes(ip));
  if (onRender) {
    add('ok', 'buildpipeline', `Apex points at Render (${addresses.join(', ')}).`, null);
  } else {
    add('blocked', 'buildpipeline',
      `Apex resolves to ${addresses.join(', ')}, which is not a Render address.`,
      'Step 2 of the launch checklist is undone: attach the domain in Render, then point DNS at the record it gives you. Every later step depends on it.');
  }
}

function checkUncommitted() {
  // Excludes CLAUDE.md deliberately: changes to the instruction file are the
  // owner's to review and commit, and this check should not nag about them.
  const dirty = git(['status', '--porcelain', '--', ':!CLAUDE.md']);
  if (dirty) add('warn', 'repo', `Uncommitted changes:\n${dirty}`, 'Commit or discard.');
  else add('ok', 'repo', 'Working tree clean (CLAUDE.md excluded).', null);
}

async function main() {
  checkMainActivity();
  checkUnmergedWork();
  checkHarvestYield();
  checkUncommitted();
  checkCi();
  await checkBuildPipelineDns();

  const order = { stalled: 0, blocked: 1, warn: 2, ok: 3 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  const actionable = findings.filter(f => f.level !== 'ok');

  console.log(`\nOPS STATUS — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`);
  console.log(`${actionable.length} item(s) need attention, ${findings.length - actionable.length} healthy\n`);

  for (const f of findings) {
    const tag = f.level.toUpperCase().padEnd(8);
    console.log(`[${tag}] ${f.area}`);
    console.log(`           ${f.finding.replace(/\n/g, '\n           ')}`);
    if (f.action) console.log(`    ACTION  ${f.action}`);
    console.log();
  }

  // Non-zero when something is stalled or blocked, so a scheduled run can key
  // off the exit code instead of parsing this text.
  process.exitCode = actionable.some(f => f.level === 'stalled' || f.level === 'blocked') ? 1 : 0;
}

if (require.main === module) main();
module.exports = { main };
