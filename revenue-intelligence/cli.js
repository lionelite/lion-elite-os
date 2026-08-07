'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generateExecutiveReport } = require('./index');

function readInput() {
  const fileArg = process.argv[2];
  if (fileArg) {
    const resolved = path.resolve(process.cwd(), fileArg);
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  }

  if (!process.stdin.isTTY) {
    const chunks = [];
    return new Promise((resolve, reject) => {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => {
        try {
          const text = chunks.join('').trim();
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
      process.stdin.on('error', reject);
    });
  }

  return {};
}

function printHuman(report) {
  const { revenue, pipeline, dailyActions, topRevenueLeaks } = report;
  console.log('LIONOS REVENUE INTELLIGENCE');
  console.log(`Generated: ${report.generatedAt}`);
  console.log('');
  console.log(`Revenue today: $${revenue.revenueToday}`);
  console.log(`Revenue MTD: $${revenue.revenueMTD} / $${revenue.monthlyTarget}`);
  console.log(`Target progress: ${revenue.targetProgressPct}%`);
  console.log(`Projected month: $${revenue.projectedMonthRevenue}`);
  console.log(`Required daily pace: $${revenue.requiredDailyPace}`);
  console.log(`Orders MTD: ${revenue.ordersMTD}`);
  console.log(`AOV: $${revenue.averageOrderValue}`);
  console.log(`Attribution coverage: ${revenue.attributionCoveragePct}%`);
  console.log(`Weighted pipeline: $${pipeline.weightedPipelineValue}`);
  console.log(`Overdue follow-ups: ${pipeline.overdueFollowUps}`);
  console.log('');
  console.log('TOP REVENUE LEAKS');
  if (!topRevenueLeaks.length) console.log('- No material leaks detected from supplied data.');
  for (const leak of topRevenueLeaks) {
    console.log(`- [${leak.severity}] ${leak.type}: ${leak.evidence}`);
  }
  console.log('');
  console.log('TODAY\'S ACTIONS');
  if (!dailyActions.length) console.log('- Supply live revenue and pipeline data to rank actions.');
  for (const action of dailyActions) {
    console.log(`${action.priority}. ${action.action} (${action.owner}) — ${action.reason}`);
  }
}

async function main() {
  try {
    const input = await readInput();
    const report = generateExecutiveReport(input);
    if (process.env.REVENUE_REPORT_FORMAT === 'json' || process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printHuman(report);
    }
  } catch (error) {
    console.error(`Revenue Intelligence Engine failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { readInput, printHuman };
