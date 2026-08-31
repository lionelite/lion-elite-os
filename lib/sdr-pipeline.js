'use strict';

const { PostgresProspectStore } = require('./postgres-prospect-store');

const store = new PostgresProspectStore();

const NICHE_RULES = [
  ['fitness_gym', /gym|fitness center|health club|strength|crossfit/i],
  ['personal_trainer', /personal trainer|fitness coach|online coach|bodybuilding coach/i],
  ['studio', /pilates|yoga|barre|boxing studio|martial arts|dance studio/i],
  ['wellness_clinic', /wellness|med spa|clinic|longevity|recovery|chiropractic|physical therapy/i],
  ['ecommerce', /shopify|ecommerce|e-commerce|online store|dtc|direct to consumer/i],
  ['agency_services', /agency|consulting|professional services|marketing firm/i],
  ['real_estate', /real estate|realtor|brokerage|property management|investor/i],
  ['local_services', /roofing|hvac|plumbing|landscaping|contractor|cleaning|auto detailing/i],
  ['saas_technology', /saas|software|technology|tech startup|app company/i],
  ['hospitality', /restaurant|hotel|hospitality|cafe|barbershop|salon/i]
];

function textFor(input = {}) {
  return [
    input.business?.name,
    input.business?.description,
    input.business?.category,
    input.business?.industry,
    input.publicSignals?.join?.(' '),
    input.notes
  ].filter(Boolean).join(' ');
}

function classifyNiche(input = {}) {
  const text = textFor(input);
  const match = NICHE_RULES.find(([, pattern]) => pattern.test(text));
  return match?.[0] || 'other_b2b';
}

function chooseBrand(input = {}, niche = classifyNiche(input)) {
  if (['fitness_gym','personal_trainer','studio','wellness_clinic'].includes(niche)) return 'lion_elite_beauty';
  if (/affiliate|wholesale|reseller|distribution/i.test(textFor(input))) return 'lion_elite_wellness';
  return 'lionos';
}

function scoreOpportunity(input = {}) {
  const text = textFor(input).toLowerCase();
  let score = 20;
  const reasons = [];

  const add = (points, reason) => { score += points; reasons.push(reason); };
  if (input.business?.domain || input.business?.website) add(8, 'verified web presence');
  if (input.contact?.email || input.contact?.phone) add(10, 'public business contact available');
  if (input.business?.location) add(4, 'location identified');
  if (/looking for|need help|need a|seeking|hiring|recommend|anyone know/i.test(text)) add(18, 'active buying or help-seeking signal');
  if (/scale|grow|growth|more clients|lead generation|crm|automation|follow[- ]?up|pipeline/i.test(text)) add(16, 'growth or systems pain identified');
  if (/manual|overwhelmed|too busy|missing leads|losing leads|no[- ]?show|follow up/i.test(text)) add(14, 'clear operational pain');
  if (/multiple locations|team of|staff|employees|franchise|expanding/i.test(text)) add(12, 'business scale signal');
  if (/partner|partnership|affiliate|wholesale|bulk|reseller|distribution/i.test(text)) add(14, 'partnership intent');
  if (Number(input.business?.reviewCount || 0) >= 50) add(5, 'established local demand');

  return { score: Math.min(100, score), reasons };
}

function buildSalesContext(input = {}) {
  const niche = classifyNiche(input);
  const brand = chooseBrand(input, niche);
  const opportunity = scoreOpportunity(input);
  const publicSignals = Array.isArray(input.publicSignals) ? input.publicSignals.slice(0, 10) : [];
  return {
    niche,
    brand,
    opportunityScore: opportunity.score,
    qualificationReasons: opportunity.reasons,
    publicSignals,
    sourceUrl: input.sourceUrl || null,
    sourceType: input.sourceType || 'public_business_information',
    suggestedAngle: brand === 'lionos'
      ? 'Lead with the specific growth or operational bottleneck found publicly and position LionOS around automation, CRM, lead follow-up, or sales systems.'
      : brand === 'lion_elite_beauty'
        ? 'Explore a coaching, trainer, gym, or studio partnership tied to client outcomes, accountability, and shared revenue opportunities.'
        : 'Explore affiliate or wholesale fit using research-use-only brand standards and business-focused partnership language.'
  };
}

async function addPublicProspect(input = {}, actor = 'sdr-agent') {
  if (!input.business?.name) throw Object.assign(new Error('Business name is required.'), { code: 'MISSING_BUSINESS_NAME' });
  if (!input.business?.domain && !input.business?.website) throw Object.assign(new Error('A public business domain or website is required.'), { code: 'MISSING_PUBLIC_IDENTITY' });

  const context = buildSalesContext(input);
  const campaignId = input.campaignId || `sdr_${context.brand}`;
  const result = await store.create({
    business: { ...input.business, niche: context.niche, sourceUrl: context.sourceUrl, sourceType: context.sourceType },
    contact: input.contact || null,
    campaignId,
    ownerId: input.ownerId || 'sales'
  }, actor);

  const prospect = result.prospect;
  if (!result.duplicate) {
    await store.update(prospect.prospectId, {
      score: context.opportunityScore,
      enrichment: {
        sourceType: context.sourceType,
        sourceUrl: context.sourceUrl,
        publicSignals: context.publicSignals
      },
      personalization: {
        brand: context.brand,
        niche: context.niche,
        suggestedAngle: context.suggestedAngle,
        qualificationReasons: context.qualificationReasons
      },
      nextAction: context.opportunityScore >= 60 ? 'sales_rep_contact' : 'continue_research'
    }, actor);
    await store.transition(prospect.prospectId, context.opportunityScore >= 60 ? 'qualified' : 'research_complete', {
      source: 'automated_sdr',
      opportunityScore: context.opportunityScore,
      brand: context.brand,
      niche: context.niche
    }, actor);
  }

  return { ...result, context };
}

async function listSalesReady({ brand, limit = 100 } = {}) {
  const prospects = await store.list({ stage: 'qualified' });
  return prospects
    .filter(p => !brand || p.personalization?.brand === brand)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 500)));
}

module.exports = { classifyNiche, chooseBrand, scoreOpportunity, buildSalesContext, addPublicProspect, listSalesReady };
