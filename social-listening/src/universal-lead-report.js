'use strict';

const { buildBlueskyLeadReport } = require('../../lib/bluesky-lead-report');

async function main() {
  const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 50;
  const report = await buildBlueskyLeadReport({ limit });

  console.log(`\nBluesky Universal Lead Intelligence`);
  console.log(`Stored leads: ${report.totalLeads}`);
  console.log(`Generated: ${report.generatedAt}\n`);

  console.log('Highest lead-generation opportunities across all niches:');
  if (!report.topLeads.length) console.log('No stored leads yet.');
  report.topLeads.slice(0, 20).forEach((lead, index) => {
    console.log(`${index + 1}. ${lead.score}/100 — ${lead.niche}`);
    console.log(`   ${String(lead.postText || '').replace(/\s+/g, ' ').slice(0, 220)}`);
    if (lead.postUrl) console.log(`   ${lead.postUrl}`);
  });

  console.log('\nBest niches right now:');
  if (!report.niches.length) console.log('No niche data yet.');
  report.niches.forEach((niche, index) => {
    console.log(`${index + 1}. ${niche.niche} — opportunity ${niche.opportunityIndex}/100 | leads ${niche.leadCount} | avg ${niche.averageScore}/100 | top ${niche.topScore}/100`);
  });
}

main().catch(error => {
  console.error(`[bluesky-leads] FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
