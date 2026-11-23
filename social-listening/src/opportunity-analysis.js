'use strict';

// Deterministic opportunity analysis for surfaced social-listening matches.
// This does not fetch private data or infer protected traits. It only scores
// the public post text already captured by the read-only listener.

const NICHE_RULES = [
  { niche: 'E-commerce / DTC', terms: ['ecommerce', 'e-commerce', 'shopify', 'online store', 'amazon seller', 'dtc', 'direct to consumer'] },
  { niche: 'Agency / Professional Services', terms: ['agency', 'consulting', 'consultant', 'law firm', 'accounting firm', 'bookkeeping', 'marketing firm', 'professional services'] },
  { niche: 'Local Services', terms: ['local business', 'contractor', 'hvac', 'plumber', 'plumbing', 'roofing', 'landscaping', 'cleaning business', 'detailing', 'salon', 'barbershop', 'med spa'] },
  { niche: 'Real Estate', terms: ['real estate', 'realtor', 'brokerage', 'property management', 'investor', 'mortgage', 'wholesaling'] },
  { niche: 'Coaching / Fitness', terms: ['coach', 'coaching', 'personal trainer', 'personal training', 'fitness', 'gym', 'nutrition'] },
  { niche: 'SaaS / Startup', terms: ['saas', 'software', 'startup', 'app', 'tech company', 'founder'] },
  { niche: 'Healthcare / Wellness', terms: ['clinic', 'medical practice', 'healthcare', 'wellness', 'peptide', 'laboratory', 'research lab', 'medspa', 'med spa'] },
  { niche: 'Restaurant / Hospitality', terms: ['restaurant', 'bar', 'hotel', 'hospitality', 'cafe', 'coffee shop'] },
  { niche: 'Creator / Media', terms: ['creator', 'content creator', 'influencer', 'youtube', 'podcast', 'newsletter'] }
];

const HIGH_VALUE_SIGNALS = [
  ['revenue', 8], ['six figures', 10], ['7 figures', 12], ['seven figures', 12],
  ['team', 5], ['employees', 6], ['multiple locations', 10], ['franchise', 10],
  ['crm', 6], ['sales pipeline', 7], ['lead generation', 7], ['automation', 7],
  ['operations', 6], ['scale', 6], ['scaling', 6], ['grow', 4], ['growth', 4],
  ['hire', 5], ['agency', 4], ['consultant', 4], ['budget', 8], ['spend', 5]
];

const URGENCY_SIGNALS = [
  ['need help', 8], ['struggling', 7], ['stuck', 6], ['asap', 10], ['urgent', 10],
  ['losing leads', 10], ['missing leads', 9], ['not converting', 8], ['need a system', 8],
  ['overwhelmed', 6], ['manual', 5], ['wasting time', 7], ['too much time', 5]
];

function includesTerm(text, term) {
  return text.toLowerCase().includes(term.toLowerCase());
}

function classifyNiche(text, audience) {
  const normalized = String(text || '').toLowerCase();
  let best = { niche: 'General Small Business', hits: 0 };
  for (const rule of NICHE_RULES) {
    const hits = rule.terms.filter((term) => normalized.includes(term)).length;
    if (hits > best.hits) best = { niche: rule.niche, hits };
  }
  if (best.hits > 0) return best.niche;
  if (audience === 'research-peptides') return 'Research / Laboratory Supply';
  if (audience === 'personal-training') return 'Coaching / Fitness';
  return 'General Small Business';
}

function scoreOpportunity(entry) {
  const text = String(entry?.post?.text || '');
  const match = entry?.match || {};
  if (match.doNotEngage) return 0;

  let score = Math.min(55, Number(match.score || 0) * 0.55);
  if (match.audience === 'business-scaling') score += 15;
  if (match.audience === 'personal-training') score += 6;
  if (match.audience === 'research-peptides') score += 5;

  for (const [term, points] of HIGH_VALUE_SIGNALS) {
    if (includesTerm(text, term)) score += points;
  }
  for (const [term, points] of URGENCY_SIGNALS) {
    if (includesTerm(text, term)) score += points;
  }

  // Direct buying/hiring intent is more valuable than general curiosity.
  const intent = (match.matched?.intent || []).map((x) => String(x).toLowerCase());
  if (intent.some((x) => ['hire', 'need someone', 'service', 'solution', 'agency', 'consultant'].includes(x))) score += 12;
  if (intent.some((x) => ['looking for', 'need help', 'trying to find'].includes(x))) score += 6;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function analyzeOpportunities(entries) {
  const analyzed = (entries || [])
    .filter((entry) => !entry?.match?.doNotEngage)
    .map((entry) => ({
      ...entry,
      opportunity: {
        moneyScore: scoreOpportunity(entry),
        niche: classifyNiche(entry?.post?.text, entry?.match?.audience)
      }
    }))
    .sort((a, b) => b.opportunity.moneyScore - a.opportunity.moneyScore);

  const byNiche = new Map();
  for (const entry of analyzed) {
    const key = entry.opportunity.niche;
    const current = byNiche.get(key) || { niche: key, count: 0, totalScore: 0, topScore: 0, topEntry: null };
    current.count += 1;
    current.totalScore += entry.opportunity.moneyScore;
    if (entry.opportunity.moneyScore > current.topScore) {
      current.topScore = entry.opportunity.moneyScore;
      current.topEntry = entry;
    }
    byNiche.set(key, current);
  }

  const niches = [...byNiche.values()]
    .map((item) => ({ ...item, avgScore: Math.round(item.totalScore / item.count) }))
    .sort((a, b) => (b.avgScore * b.count) - (a.avgScore * a.count));

  return {
    topOpportunities: analyzed.slice(0, 10),
    niches,
    analyzedCount: analyzed.length
  };
}

module.exports = { classifyNiche, scoreOpportunity, analyzeOpportunities };
