'use strict';

const OUTBOUND_SEGMENTS = Object.freeze([
  {
    key: 'founders-operators',
    label: 'Founders & owner-operators',
    channel: 'outbound',
    fit: ['Founder','Co-Founder','Owner','CEO','President','Managing Partner'],
    companySize: '1-200',
    hypotheses: ['high responsibility','inconsistent structure','identity tied to business performance','needs accountability outside the company'],
    angle: 'Build the person operating the business: energy, confidence, standards, discipline and a clear 90-day personal operating plan.'
  },
  {
    key: 'commission-professionals',
    label: 'Commission-based professionals',
    channel: 'outbound',
    fit: ['Account Executive','Sales Executive','Sales Manager','Mortgage Loan Officer','Insurance Agent','Recruiter'],
    companySize: '1-5000',
    hypotheses: ['performance pressure','confidence directly affects income','inconsistent routine','needs stronger personal systems'],
    angle: 'Improve confidence, consistency, energy and execution so performance is less dependent on mood or momentum.'
  },
  {
    key: 'real-estate-professionals',
    label: 'Real estate professionals',
    channel: 'outbound',
    fit: ['Realtor','Real Estate Agent','Broker','Real Estate Investor','Acquisitions Manager'],
    companySize: '1-500',
    hypotheses: ['income variability','self-managed schedule','high rejection environment','personal brand pressure'],
    angle: 'Create structure, stronger self-belief and a personal operating system that supports production and lifestyle.'
  },
  {
    key: 'executives-leaders',
    label: 'Executives & people leaders',
    channel: 'outbound',
    fit: ['Chief Executive Officer','Chief Operating Officer','Vice President','Director','General Manager'],
    companySize: '10-5000',
    hypotheses: ['high cognitive load','little external accountability','health and personal life can become secondary'],
    angle: 'Upgrade the person behind the title: health, energy, confidence, boundaries, goals and accountability.'
  },
  {
    key: 'creators-coaches',
    label: 'Creators, coaches & personal brands',
    channel: 'outbound',
    fit: ['Coach','Consultant','Creator','Influencer','Personal Trainer','Fitness Coach'],
    companySize: '1-50',
    hypotheses: ['visibility pressure','personal identity is part of the product','inconsistent execution','needs stronger personal standards'],
    angle: 'Align the person, brand and daily behavior so confidence and consistency match the life they are trying to build.'
  },
  {
    key: 'fitness-wellness-professionals',
    label: 'Fitness & wellness professionals',
    channel: 'outbound',
    fit: ['Personal Trainer','Gym Owner','Fitness Director','Wellness Coach','Health Coach'],
    companySize: '1-200',
    hypotheses: ['helps others while neglecting own systems','appearance and energy affect credibility','entrepreneurial pressure'],
    angle: 'A full-life audit that connects mindset, body, business, relationships, money and purpose instead of treating them separately.'
  }
]);

const INBOUND_INTENT_THEMES = Object.freeze([
  {
    key: 'life-reset',
    label: 'I need to get my life together',
    searchIntent: ['how to get my life together','how to reset my life','change my life','life transformation coach','personal development coach'],
    promise: 'Start with a complete life audit, identify the highest-leverage changes, and build a 30/90/365-day plan.'
  },
  {
    key: 'confidence',
    label: 'Confidence & self-belief',
    searchIntent: ['how to build confidence','confidence coach','how to believe in myself','low self confidence help','become more confident'],
    promise: 'Build self-trust through standards, action, competence, health, communication and consistent follow-through.'
  },
  {
    key: 'discipline',
    label: 'Discipline & consistency',
    searchIntent: ['how to be more disciplined','discipline coach','how to stay consistent','stop procrastinating on goals','build better habits'],
    promise: 'Replace motivation-dependent behavior with structure, routines, accountability and measurable commitments.'
  },
  {
    key: 'direction',
    label: 'Direction, goals & purpose',
    searchIntent: ['I feel stuck in life','what should I do with my life','need direction in life','goal setting coach','find my purpose coach'],
    promise: 'Clarify the desired future, identify the gap, and build an execution plan around the few changes that matter most.'
  },
  {
    key: 'career-money',
    label: 'Career, business & money',
    searchIntent: ['career confidence coach','business accountability coach','how to become more successful','how to increase income mindset','career direction coach'],
    promise: 'Connect identity, confidence, skill-building, execution and financial goals into one practical plan.'
  },
  {
    key: 'health-energy',
    label: 'Health, energy & lifestyle',
    searchIntent: ['how to improve energy and lifestyle','health accountability coach','get back in shape and motivated','lifestyle reset coach','sleep fitness habits coach'],
    promise: 'Improve the controllable foundations: sleep, training, nutrition, routines, environment and appropriate professional evaluation when needed.'
  },
  {
    key: 'relationships-standards',
    label: 'Relationships, boundaries & standards',
    searchIntent: ['how to set better boundaries','relationship confidence coach','raise my standards in life','how to communicate with confidence'],
    promise: 'Evaluate patterns, boundaries, communication, environment and the standards the client is willing to live by.'
  }
]);

const SELF_DECLARED_ONLY = Object.freeze([
  'medical diagnoses',
  'mental-health diagnoses',
  'addiction or recovery status',
  'trauma history',
  'sexual orientation or sex life',
  'religion',
  'race or ethnicity',
  'political affiliation',
  'disability',
  'fertility status',
  'divorce, bereavement or other private life events'
]);

function acquisitionCatalog() {
  return {
    product: 'Life Transformation / Life Audit',
    conversion: {
      primary: 'Complete the Life Audit intake',
      secondary: 'Book a consultation',
      framework: ['current state','desired future','top 3 priorities','30-day actions','90-day targets','365-day vision','accountability']
    },
    outboundSegments: OUTBOUND_SEGMENTS.map(x => ({...x})),
    inboundIntentThemes: INBOUND_INTENT_THEMES.map(x => ({...x})),
    targetingGuardrail: {
      rule: 'Use professional/public business criteria for outbound. Use search intent, content engagement and self-declared form answers for consumer personalization. Do not infer or target private sensitive conditions.',
      selfDeclaredOnly: [...SELF_DECLARED_ONLY]
    }
  };
}

function intentTheme(key) {
  return INBOUND_INTENT_THEMES.find(x => x.key === key) || null;
}

module.exports = {
  OUTBOUND_SEGMENTS,
  INBOUND_INTENT_THEMES,
  SELF_DECLARED_ONLY,
  acquisitionCatalog,
  intentTheme
};
