'use strict';

const DEFAULT_SIGNATURE = Object.freeze({
  name: 'Alexander Ringfield',
  brand: 'Lion Elite Beauty',
  phone: '216-326-0050',
  website: 'https://lionelitebeauty.com'
});

const OFFER_LIBRARY = Object.freeze({
  affiliate: {
    label: 'affiliate partnership',
    value: 'create an additional revenue stream by connecting the right clients with structured coaching and accountability support'
  },
  referral: {
    label: 'referral partnership',
    value: 'give members a trusted next step when they need more structure, accountability, and personalized guidance outside the studio'
  },
  coaching: {
    label: 'coaching collaboration',
    value: 'extend the support clients receive between sessions with a personalized roadmap, accountability, and consistent follow-through'
  },
  content: {
    label: 'content collaboration',
    value: 'co-create useful education that strengthens member trust, increases engagement, and introduces both brands to aligned audiences'
  },
  education: {
    label: 'member education partnership',
    value: 'provide practical education and support that helps members stay engaged with their goals and get more value from their existing training'
  }
});

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentence(value) {
  const text = clean(value);
  if (!text) return '';
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function selectOffer(input = {}) {
  const requested = clean(input.recommendedOffer || input.partnershipAngle || input.offer).toLowerCase();
  const keys = Object.keys(OFFER_LIBRARY);
  const key = keys.find(item => requested.includes(item)) || 'referral';
  return { key, ...OFFER_LIBRARY[key] };
}

function verifiedFacts(input = {}) {
  return (input.verifiedFacts || [])
    .filter(item => item && (typeof item === 'string' || item.status === 'verified'))
    .map(item => clean(typeof item === 'string' ? item : item.text || item.claim))
    .filter(Boolean);
}

function chooseRapportHook(input = {}) {
  const facts = verifiedFacts(input);
  if (facts.length) return `I was looking into ${clean(input.businessName)} and noticed ${facts[0].replace(/^[A-Z]/, char => char.toLowerCase())}`;

  const category = clean(input.category || input.industry);
  const location = clean(input.location);
  if (category && location) return `I came across ${clean(input.businessName)} while looking at strong ${category.toLowerCase()} businesses in ${location}`;
  if (category) return `I came across ${clean(input.businessName)} and liked the focus you have built around ${category.toLowerCase()}`;
  return `I came across ${clean(input.businessName)} and wanted to reach out personally`;
}

function inferGoal(input = {}) {
  const explicit = clean(input.goal || input.businessGoal || input.opportunity);
  if (explicit) return explicit;

  const category = clean(input.category || input.industry).toLowerCase();
  if (category.includes('gym') || category.includes('fitness') || category.includes('training')) {
    return 'helping more members stay consistent long enough to achieve meaningful results';
  }
  if (category.includes('wellness') || category.includes('beauty') || category.includes('aesthetic')) {
    return 'increasing client trust, retention, and long-term engagement';
  }
  return 'creating more value for clients while growing the business through aligned partnerships';
}

function buildSubject(input = {}, offer) {
  const businessName = clean(input.businessName) || 'your team';
  const options = [
    `A partnership idea for ${businessName}`,
    `Helping ${businessName} create more client value`,
    `${businessName} + Lion Elite Beauty`,
    `A simple ${offer.label} idea`
  ];
  const index = Math.abs(clean(input.businessName).length + clean(input.category).length) % options.length;
  return options[index];
}

function buildEmail(input = {}, options = {}) {
  const businessName = clean(input.businessName);
  if (!businessName) throw new Error('businessName is required.');

  const offer = selectOffer(input);
  const contactName = clean(input.contactName);
  const greeting = contactName ? `Hi ${contactName},` : `Hi ${businessName} team,`;
  const rapport = chooseRapportHook(input);
  const goal = inferGoal(input);
  const specificOpportunity = clean(input.specificOpportunity || input.valueHypothesis);
  const proof = clean(input.proof || input.credibility);
  const question = clean(input.ctaQuestion) || 'Would you be open to a quick conversation to see whether this could add value for your members and your business?';
  const signature = { ...DEFAULT_SIGNATURE, ...(options.signature || input.signature || {}) };

  const bodyParagraphs = [
    greeting,
    `${sentence(rapport)} What stood out to me is how closely that connects with our focus at Lion Elite Beauty: helping people build the structure, accountability, and support needed to keep moving toward their goals.`,
    `I believe there may be a strong ${offer.label} opportunity between us. The goal would be to ${specificOpportunity || offer.value}, while supporting your larger goal of ${goal}.`,
    proof ? sentence(proof) : 'We focus on making the experience personal, high-touch, and useful so the client feels supported rather than sold to.',
    question,
    `Best,\n${signature.name}\n${signature.brand}\n${signature.phone}\n${signature.website}`
  ];

  const draft = {
    subject: buildSubject(input, offer),
    body: bodyParagraphs.join('\n\n'),
    offer,
    signature,
    personalizationInputs: {
      businessName,
      contactName: contactName || null,
      verifiedFacts: verifiedFacts(input),
      goal,
      specificOpportunity: specificOpportunity || null
    }
  };

  draft.quality = scoreEmail(draft, input);
  draft.approved = draft.quality.score >= Number(options.minimumScore ?? 56.25) && draft.quality.blockers.length === 0;
  return draft;
}

function scoreEmail(draft, input = {}) {
  const body = clean(draft.body);
  const facts = verifiedFacts(input);
  const dimensions = {
    specificity: Math.min(100, 45 + (facts.length * 20) + (clean(input.specificOpportunity) ? 25 : 0)),
    relevance: clean(input.goal || input.businessGoal || input.opportunity) ? 100 : 75,
    valueClarity: body.includes('The goal would be to') ? 95 : 60,
    rapport: body.includes('What stood out to me') ? 90 : 60,
    callToAction: /\?$/.test(body.split('\n\n').filter(Boolean).slice(-2, -1)[0] || '') ? 95 : 65,
    readability: body.length <= 1700 ? 95 : 65,
    signature: body.includes('216-326-0050') && body.includes('lionelitebeauty.com') ? 100 : 0,
    evidence: facts.length ? Math.min(100, 65 + facts.length * 15) : 55
  };

  const blockers = [];
  if (!clean(input.businessName)) blockers.push('missing_business_name');
  if (/guarantee|guaranteed results|cure|treat disease/i.test(body)) blockers.push('prohibited_claim');
  if (!body.includes('216-326-0050')) blockers.push('missing_phone_signature');
  if (facts.some(fact => !body.toLowerCase().includes(fact.toLowerCase().slice(0, 24)))) blockers.push('verified_fact_not_used');

  const values = Object.values(dimensions);
  const score = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  return { score, dimensions, blockers };
}

module.exports = {
  DEFAULT_SIGNATURE,
  OFFER_LIBRARY,
  buildEmail,
  scoreEmail,
  selectOffer,
  verifiedFacts
};
