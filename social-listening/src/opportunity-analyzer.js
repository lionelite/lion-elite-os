'use strict';

// Analyze recent surfaced Bluesky matches and rank the highest-value niches.
// This is local-only: it reads social-listening/data/*.jsonl and never sends
// post content anywhere.

const { loadRecentMatches } = require('./store');

const NICHE_RULES = [
  {
    key: 'lead-generation',
    label: 'Lead generation & client acquisition',
    terms: ['lead generation', 'generate leads', 'more leads', 'get clients', 'getting clients', 'client acquisition', 'customer acquisition', 'book appointments', 'appointment setting', 'sales pipeline', 'pipeline'],
    baseValue: 95
  },
  {
    key: 'sales-automation',
    label: 'Sales automation & CRM',
    terms: ['crm', 'sales automation', 'sales system', 'sales systems', 'follow-up', 'follow up', 'lead nurturing', 'pipeline automation', 'automate sales'],
    baseValue: 92
  },
  {
    key: 'ai-automation',
    label: 'AI & workflow automation',
    terms: ['ai automation', 'business automation', 'workflow automation', 'automate my business', 'automate our business', 'automate tasks', 'manual process', 'manual processes', 'save time', 'operations automation'],
    baseValue: 90
  },
  {
    key: 'marketing-automation',
    label: 'Marketing automation',
    terms: ['marketing automation', 'email automation', 'email marketing', 'content automation', 'social media automation', 'funnel', 'funnels', 'marketing system'],
    baseValue: 88
  },
  {
    key: 'operations-scaling',
    label: 'Operations & scaling systems',
    terms: ['scale my business', 'scaling my business', 'grow my business', 'growing my business', 'scale the business', 'business systems', 'operations', 'sop', 'sops', 'processes', 'bottleneck', 'bottlenecks'],
    baseValue: 86
  },
  {
    key: 'ecommerce',
    label: 'E-commerce growth',
    terms: ['ecommerce', 'e-commerce', 'shopify', 'online store', 'conversion rate', 'abandoned cart', 'store sales'],
    baseValue: 91
  },
  {
    key: 'local-service-business',
    label: 'Local service businesses',
    terms: ['contractor', 'roofing', 'hvac', 'plumber', 'plumbing', 'dentist', 'dental', 'med spa', 'clinic', 'realtor', 'real estate agent', 'law firm', 'attorney', 'landscaping', 'cleaning business'],
    baseValue: 93
  },
  {
    key: 'coaches-consultants',
    label: 'Coaches, consultants & experts',
    terms: ['coach', 'coaching business', 'consultant', 'consulting business', 'course creator', 'agency owner'],
    baseValue: 82
  }
];

const MONEY_SIGNALS = [
  ['budget', 12], ['spend', 8], ['revenue', 10], ['sales', 8], ['customers', 6], ['clients', 6],
  ['team', 5], ['employees', 5], ['agency', 5], ['business owner', 8], ['founder', 8], ['ceo', 8],
  ['urgent', 8], ['asap', 8], ['need help', 8], ['looking for', 6], ['recommend', 4], ['hire', 10]
];

function includesTerm(text, term) {
  return text.includes(term);
}

function scoreEntry(entry, rule) {
  const text = String(entry?.post?.text || '').toLowerCase();
  const hits = rule.terms.filter((term) => includesTerm(text, term));
  if (hits.length === 0) return null;

  let valueScore = rule.baseValue + Math.min(10, (hits.length - 1) * 3);
  const signals = [];
  for (const [term, points] of MONEY_SIGNALS) {
    if (includesTerm(text, term)) {
      valueScore += points;
      signals.push(term);
    }
  }

  valueScore += Math.min(10, Math.max(0, Number(entry?.match?.score || 0) - 40) / 4);
  valueScore = Math.min(100, Math.round(valueScore));

  return { hits, signals, valueScore };
}

function analyzeOpportunities({ days = 7, limit = 10 } = {}) {
  const matches = loadRecentMatches({ days }).filter((entry) => !entry?.match?.doNotEngage);
  const niches = new Map();

  for (const entry of matches) {
    for (const rule of NICHE_RULES) {
      const scored = scoreEntry(entry, rule);
      if (!scored) continue;
      if (!niches.has(rule.key)) {
        niches.set(rule.key, { key: rule.key, label: rule.label, posts: [], totalValue: 0 });
      }
      const niche = niches.get(rule.key);
      niche.posts.push({
        valueScore: scored.valueScore,
        text: entry.post.text,
        url: entry.post.url,
        seenAt: entry.seenAt,
        signals: scored.signals,
        matchedTerms: scored.hits
      });
      niche.totalValue += scored.valueScore;
    }
  }

  return [...niches.values()]
    .map((niche) => {
      niche.posts.sort((a, b) => b.valueScore - a.valueScore);
      const top = niche.posts.slice(0, 5);
      const avgValue = niche.posts.length ? Math.round(niche.totalValue / niche.posts.length) : 0;
      const opportunityScore = Math.min(100, Math.round(avgValue * 0.7 + Math.min(30, niche.posts.length * 3)));
      return {
        niche: niche.label,
        opportunityScore,
        leadCount: niche.posts.length,
        averageLeadValueScore: avgValue,
        topLeads: top
      };
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, limit);
}

function printReport(report, days) {
  console.log(`\nLionOS Opportunity Intelligence — last ${days} day(s)`);
  console.log('Ranked by lead intent, commercial value signals, and frequency.\n');
  if (report.length === 0) {
    console.log('No qualifying opportunities yet. Let the listener collect more posts and run this again.');
    return;
  }
  report.forEach((item, index) => {
    console.log(`${index + 1}. ${item.niche}`);
    console.log(`   Opportunity score: ${item.opportunityScore}/100 | Leads: ${item.leadCount} | Avg lead value: ${item.averageLeadValueScore}/100`);
    for (const lead of item.topLeads.slice(0, 3)) {
      console.log(`   - ${lead.valueScore}/100: ${lead.text.replace(/\s+/g, ' ').slice(0, 180)}`);
      console.log(`     ${lead.url}`);
    }
  });
}

if (require.main === module) {
  const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
  const days = daysArg ? Number(daysArg.slice(7)) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
  const report = analyzeOpportunities({ days });
  printReport(report, days);
}

module.exports = { analyzeOpportunities, NICHE_RULES };
