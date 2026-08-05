'use strict';

// Broad, niche-agnostic lead-intent detection for public Bluesky posts.
// This runs independently of the three brand-specific audience profiles so
// LionOS can discover and rank opportunities across the whole market.

const NICHE_RULES = [
  { niche: 'Lead Generation / Marketing', terms: ['lead generation','generate leads','more leads','get more clients','client acquisition','customer acquisition','marketing','ads','advertising','seo','social media','email marketing','funnel','conversion rate'] },
  { niche: 'Sales / CRM', terms: ['crm','sales pipeline','sales process','sales system','close more sales','follow-up','follow up','appointment setting','sales automation','lead nurturing'] },
  { niche: 'AI / Automation', terms: ['ai automation','automation','automate','workflow','manual process','manual processes','ai agent','chatbot','artificial intelligence'] },
  { niche: 'E-commerce / DTC', terms: ['ecommerce','e-commerce','shopify','online store','amazon seller','dtc','direct to consumer','abandoned cart'] },
  { niche: 'Real Estate', terms: ['real estate','realtor','brokerage','property management','mortgage','real estate investor','wholesaling','rental property'] },
  { niche: 'Fitness / Coaching', terms: ['personal trainer','personal training','fitness coach','online coach','coaching','workout plan','nutrition coach','accountability coach','gym'] },
  { niche: 'Healthcare / Wellness', terms: ['clinic','medical practice','healthcare','wellness','med spa','medspa','doctor','dentist','dental','chiropractor','therapy practice'] },
  { niche: 'Research / Laboratory', terms: ['laboratory','research lab','researcher','peptide','research compound','coa','hplc','supplier','vendor'] },
  { niche: 'Home / Local Services', terms: ['contractor','hvac','plumber','plumbing','roofing','landscaping','cleaning business','electrician','pest control','painting company'] },
  { niche: 'Legal / Finance', terms: ['law firm','attorney','lawyer','accounting firm','accountant','bookkeeping','tax firm','financial advisor','insurance agency'] },
  { niche: 'Restaurant / Hospitality', terms: ['restaurant','bar','hotel','hospitality','cafe','coffee shop','catering'] },
  { niche: 'SaaS / Startup', terms: ['saas','software','startup','app','tech company','founder','product market fit','subscription software'] },
  { niche: 'Creator / Media', terms: ['content creator','creator','influencer','youtube','podcast','newsletter','media company'] },
  { niche: 'Recruiting / HR', terms: ['recruiting','recruiter','hiring','hire employees','staffing','talent acquisition','human resources','hr'] },
  { niche: 'Automotive', terms: ['car dealership','dealership','auto shop','mechanic','detailing','car wash','automotive'] },
  { niche: 'Beauty / Personal Care', terms: ['salon','barbershop','barber','esthetician','beauty business','spa','nail salon'] },
  { niche: 'Education / Training', terms: ['school','tutoring','course creator','online course','training company','education business'] },
  { niche: 'Logistics / Transportation', terms: ['logistics','trucking','freight','transportation company','delivery business','warehouse'] },
  { niche: 'Manufacturing / B2B', terms: ['manufacturing','manufacturer','wholesale','distributor','distribution','b2b','industrial'] }
];

const INTENT_SIGNALS = [
  ['looking for',18], ['searching for',18], ['trying to find',16], ['need help',20],
  ['need someone',22], ['who can help',20], ['anyone know',14], ['recommend',12],
  ['recommendation',12], ['any suggestions',12], ['where can i find',18], ['where do i find',18],
  ['where to find',16], ['who offers',18], ['who sells',18], ['want to hire',24], ['looking to hire',24],
  ['hire a',20], ['need a service',20], ['need a solution',20], ['need a tool',16], ['need software',18],
  ['buy',12], ['buying',14], ['purchase',14], ['vendor',10], ['supplier',10], ['consultant',10],
  ['agency',8], ['coach',8], ['service provider',14], ['help me',12], ['how do i solve',12]
];

const VALUE_SIGNALS = [
  ['budget',12], ['revenue',10], ['sales',8], ['customers',6], ['clients',6], ['team',5],
  ['employees',6], ['multiple locations',10], ['franchise',10], ['business owner',8], ['founder',8],
  ['ceo',8], ['company',4], ['business',4], ['urgent',10], ['asap',10], ['losing leads',12],
  ['not converting',10], ['wasting time',8], ['manual',6], ['overwhelmed',6], ['stuck',6],
  ['scale',6], ['scaling',6], ['grow',4], ['growth',4]
];

const PEER_PROMO_PATTERNS = [
  /\bwe help (businesses|companies|founders|brands|clients)\b/i,
  /\bi help (businesses|companies|founders|brands|clients)\b/i,
  /\bbook a (free )?(call|consultation)\b/i,
  /\bdm me (to|if|for)\b/i,
  /\baccepting (new )?clients\b/i
];

function classifyNiche(text) {
  const normalized = String(text || '').toLowerCase();
  let best = { niche: 'Other / Emerging Opportunity', hits: 0 };
  for (const rule of NICHE_RULES) {
    const hits = rule.terms.filter(term => normalized.includes(term)).length;
    if (hits > best.hits) best = { niche: rule.niche, hits };
  }
  return best;
}

function detectUniversalLead(text) {
  const normalized = String(text || '').toLowerCase();
  if (!normalized.trim()) return null;
  if (PEER_PROMO_PATTERNS.some(pattern => pattern.test(normalized))) return null;

  const intentHits = [];
  let score = 0;
  for (const [term, points] of INTENT_SIGNALS) {
    if (normalized.includes(term)) {
      intentHits.push(term);
      score += points;
    }
  }
  if (!intentHits.length) return null;

  const valueHits = [];
  for (const [term, points] of VALUE_SIGNALS) {
    if (normalized.includes(term)) {
      valueHits.push(term);
      score += points;
    }
  }

  const category = classifyNiche(normalized);
  score += Math.min(12, category.hits * 4);
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Keep the capture broad, but exclude very weak one-off mentions.
  if (score < 24) return null;

  return {
    niche: category.niche,
    opportunityScore: score,
    intentSignals: intentHits,
    valueSignals: valueHits,
    categoryHits: category.hits
  };
}

module.exports = { detectUniversalLead, classifyNiche, NICHE_RULES, INTENT_SIGNALS, VALUE_SIGNALS };
