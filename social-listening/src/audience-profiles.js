'use strict';

// Audience profiles for the Bluesky social-listening monitor.
//
// Three audiences:
//  - research-peptides (Lion Elite Wellness): researchers and lab buyers
//    discussing sourcing, vendors, COAs, purity. Posts showing PERSONAL-USE
//    intent (dosing, injecting, cycles, "I'm on...") are surfaced but
//    hard-flagged DO NOT ENGAGE — marketing research-use-only products to
//    human-use intent is outside policy (docs/customer-communication-rules.md).
//  - personal-training (Lion Elite Beauty): people publicly asking for a
//    trainer/coach or how to start training.
//  - business-scaling (LionOS): business owners publicly asking how to grow,
//    automate, generate leads, improve sales systems, or scale operations.
//  - coach-scaling (LionOS): personal trainers and fitness coaches who already
//    have clients and are trying to grow or systemize their own business.
//    Note this is the deliberate inverse of personal-training's exclusions:
//    "I'm a personal trainer" and "my clients" disqualify someone from being a
//    coaching *prospect*, but they are exactly what qualifies them here. Since
//    the portal supports multiple coaches, trainers are a customer segment,
//    not a peer to avoid. doNotEngage here targets people selling growth
//    services TO coaches, who are the actual competitors.
//
// This tool NEVER posts, replies, likes, follows, or DMs. It only surfaces
// posts, with a suggested opener a human may use manually after review.

const AUDIENCE_PROFILES = Object.freeze({
  'research-peptides': {
    key: 'research-peptides',
    brand: 'wellness',
    label: 'Researchers sourcing peptides (Lion Elite Wellness)',
    subjectTerms: [
      'peptide', 'peptides',
      'bpc-157', 'bpc157', 'bpc 157',
      'tb-500', 'tb500', 'tb 500',
      'ghk-cu', 'ghk cu',
      'retatrutide', 'tesamorelin', 'ipamorelin',
      'cjc-1295', 'cjc 1295', 'cjc/ipamorelin',
      'semax', 'selank', 'mots-c', 'epithalon', 'epitalon',
      'kpv', 'aod-9604', 'aod 9604', 'kisspeptin',
      'igf-1 lr3', 'dihexa', 'cerebrolysin', 'methylene blue',
      'nad+', 'certificate of analysis', 'lyophilized',
      'research compound', 'research compounds',
      'research chemical', 'research chemicals',
      'peptide vendor', 'peptide supplier', 'peptide source'
    ],
    intentTerms: [
      'buy', 'buying', 'purchase', 'order', 'ordering',
      'source', 'sourcing', 'vendor', 'vendors', 'supplier', 'suppliers',
      'where to get', 'where to find', 'where can i get', 'where do you get',
      'looking for', 'searching for', 'trying to find',
      'recommend', 'recommendation', 'recommendations',
      'legit', 'trustworthy', 'reliable', 'reputable',
      'price', 'prices', 'pricing', 'cost', 'sale',
      'in stock', 'restock', 'restocked',
      'anyone know', 'any suggestions', 'who sells', 'best place'
    ],
    boosterTerms: [
      'lab', 'laboratory', 'research', 'researcher', 'study', 'studies',
      'in vitro', 'in vivo', 'assay', 'cell culture', 'university',
      'coa', 'hplc', 'purity', 'batch', 'third-party tested', 'third party tested'
    ],
    doNotEngagePatterns: [
      /\bdos(e|es|ed|ing|age|ages)\b/i,
      /\binject(s|ed|ing|ions?|able)?\b/i,
      /\bsub-?q\b/i,
      /\bsubcutaneous\b/i,
      /\bintramuscular\b/i,
      /\bmy\s+(cycle|stack|protocol|regimen)\b/i,
      /\bi'?m\s+on\b/i,
      /\btook\s+my\b/i,
      /\btaking\s+(it|this|them|my)\b/i,
      /\bside\s+effects?\b/i,
      /\bbefore\s+and\s+after\b/i,
      /\bresults?\s+(so\s+far|after)\b/i,
      /\breconstitut(e|ed|ing|ion)\b/i
    ],
    doNotEngageReason:
      'Human-use intent detected. Research-use-only products must not be ' +
      'marketed to personal-use interest — do not engage (see ' +
      'docs/customer-communication-rules.md).',
    suggestedOpener:
      'If documentation quality matters to your work: our catalog publishes ' +
      'batch-specific COAs and third-party testing — lionelitewellness.com. ' +
      'For laboratory research purposes only.'
  },

  'personal-training': {
    key: 'personal-training',
    brand: 'beauty',
    label: 'People seeking personal training / coaching (Lion Elite Beauty)',
    subjectTerms: [
      'personal trainer', 'personal training',
      'fitness coach', 'fitness coaching', 'online coach', 'online coaching',
      'training program', 'workout plan', 'workout program', 'workout routine',
      'training plan', 'gym routine', 'lifting program',
      'get in shape', 'getting in shape', 'get fit', 'getting fit',
      'start working out', 'started working out', 'back in the gym',
      'weight loss coach', 'nutrition coach', 'strength training',
      'accountability partner', 'accountability coach'
    ],
    intentTerms: [
      'looking for', 'searching for', 'trying to find', 'need', 'want',
      'hire', 'hiring', 'worth it', 'should i get', 'thinking about',
      'recommend', 'recommendation', 'recommendations',
      'anyone know', 'any suggestions', 'advice', 'help me',
      'where do i start', 'how do i start', 'how to start', 'where to start',
      'no idea what', "don't know where", 'dont know where'
    ],
    boosterTerms: [
      'beginner', 'newbie', 'new to', 'starting out', 'first time',
      'motivation', 'consistency', 'accountability', 'busy schedule',
      'plateau', 'stuck', 'overwhelmed', 'goals', 'new year'
    ],
    doNotEngagePatterns: [
      /\bi'?m\s+a\s+(certified\s+)?(personal\s+)?(trainer|coach)\b/i,
      /\bmy\s+clients?\b/i,
      /\baccepting\s+(new\s+)?clients\b/i,
      /\bdm\s+me\s+to\s+(train|start|sign)\b/i
    ],
    doNotEngageReason:
      'Author appears to be a trainer/coach advertising services (peer, not a prospect).',
    suggestedOpener:
      'If what you actually want is structure and real accountability — not another random plan — that is exactly what Lion Elite Beauty coaching is built around. lionelitebeauty.com'
  },

  'business-scaling': {
    key: 'business-scaling',
    brand: 'lionos',
    label: 'Business owners looking to scale / automate (LionOS)',
    subjectTerms: [
      'scale my business', 'scale our business', 'scaling my business', 'scaling a business',
      'grow my business', 'grow our business', 'growing my business', 'business growth',
      'lead generation', 'generate leads', 'more leads', 'get more clients', 'more clients',
      'sales pipeline', 'sales system', 'sales process', 'close more sales', 'increase sales',
      'business automation', 'automate my business', 'automate our business', 'ai automation',
      'crm', 'customer relationship management', 'follow-up system', 'follow up system',
      'marketing automation', 'email automation', 'workflow automation',
      'operations', 'business systems', 'sop', 'standard operating procedure',
      'client acquisition', 'customer acquisition', 'conversion rate', 'funnel'
    ],
    intentTerms: [
      'need help', 'looking for', 'searching for', 'trying to find', 'want to',
      'how do i', 'how can i', 'how to', 'where do i start', 'where to start',
      'recommend', 'recommendation', 'recommendations', 'any suggestions',
      'anyone know', 'struggling with', 'stuck', 'overwhelmed', 'need a system',
      'need someone', 'hire', 'consultant', 'agency', 'service', 'solution'
    ],
    boosterTerms: [
      'small business', 'business owner', 'founder', 'entrepreneur', 'startup',
      'revenue', 'sales', 'clients', 'customers', 'pipeline', 'crm', 'automation',
      'ai', 'marketing', 'operations', 'team', 'agency', 'ecommerce', 'e-commerce'
    ],
    doNotEngagePatterns: [
      /\bwe\s+help\s+(businesses|founders|companies)\s+(scale|grow)\b/i,
      /\bi'?m\s+a\s+(business\s+)?(coach|consultant)\b/i,
      /\bmy\s+agency\b/i,
      /\bbook\s+a\s+(free\s+)?call\b/i,
      /\bdm\s+me\s+(to|if)\b/i,
      /\baccepting\s+(new\s+)?clients\b/i
    ],
    doNotEngageReason:
      'Author appears to be advertising business-growth services rather than seeking help.',
    suggestedOpener:
      'Saw your post about scaling. LionOS is built around practical AI automation, CRM, lead generation, sales systems, marketing automation, and business operations. Happy to compare notes on the bottleneck you are trying to solve.'
  },

  'coach-scaling': {
    key: 'coach-scaling',
    brand: 'lionos',
    label: 'Personal trainers & coaches scaling their own business (LionOS)',
    subjectTerms: [
      'training business', 'coaching business', 'personal training business',
      'my clients', 'client roster', 'more coaching clients', 'more training clients',
      'take on more clients', 'fill my roster', 'scale my coaching', 'scale my training',
      'grow my coaching', 'grow my training', 'grow my roster',
      'online coaching business', 'go online', 'online coaching',
      // Starting out, not only scaling: someone with no platform yet is the
      // clearest fit for the coach portal, and was previously invisible because
      // every subject term assumed an existing roster.
      'start online coaching', 'starting online coaching', 'start coaching online',
      'become a coach', 'becoming a coach', 'become an online coach',
      'first coaching client', 'first client', 'my first clients',
      'getting started as a', 'new coach', 'new personal trainer',
      'just got certified', 'just certified', 'passed my cpt',
      'coaching platform', 'platform for coaches', 'app for my clients',
      'what platform', 'which platform', 'software for coaching',
      'client management', 'coaching software', 'coaching platform', 'training app',
      'programming for clients', 'write programs', 'writing programs',
      'client check-ins', 'client checkins', 'manage my clients', 'managing clients',
      'onboard clients', 'onboarding clients', 'client retention', 'retention',
      'spreadsheets', 'google sheets', 'admin work', 'too much admin'
    ],
    intentTerms: [
      'how do i', 'how can i', 'how to', 'looking for', 'searching for',
      'trying to', 'want to', 'need to', 'need a', 'need help',
      'recommend', 'recommendation', 'recommendations', 'any suggestions',
      'anyone know', 'anyone else', 'struggling', 'struggling with', 'stuck',
      'overwhelmed', 'burnt out', 'burned out', 'drowning in', 'what do you use',
      'best way to', 'tired of'
    ],
    boosterTerms: [
      'personal trainer', 'fitness coach', 'strength coach', 'nutrition coach',
      'online coach', 'certified', 'cpt', 'nasm', 'issa', 'gym',
      'solo', 'one man', 'by myself', 'part time', 'full time',
      'clients', 'roster', 'income', 'rates', 'pricing', 'scale', 'systemize',
      'automate', 'waitlist', 'capacity'
    ],
    // The inverse of personal-training: being a trainer qualifies rather than
    // disqualifies. What is excluded here is the competitor selling growth
    // services to coaches, and anyone already broadcasting an offer.
    doNotEngagePatterns: [
      /\bwe\s+help\s+(coaches|trainers|personal\s+trainers|fitness\s+professionals)\b/i,
      /\bi\s+help\s+(coaches|trainers)\s+(scale|grow|get)\b/i,
      /\bmy\s+agency\b/i,
      /\bbook\s+a\s+(free\s+)?call\b/i,
      /\bdm\s+me\s+(to|if)\b/i,
      /\blink\s+in\s+bio\b/i
    ],
    doNotEngageReason:
      'Author appears to sell growth services to coaches (competitor), or is broadcasting an offer rather than asking for help.',
    suggestedOpener:
      'Saw your post about growing the coaching side. Lion Elite runs a coach portal where each coach gets their own client roster, programming, check-ins and messaging in one place, plus LionOS automation behind it. Happy to compare notes on where the admin is eating your time.'
  }
});

const AUDIENCE_KEYS = Object.freeze(Object.keys(AUDIENCE_PROFILES));

function getAudienceProfile(key) {
  const profile = AUDIENCE_PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown audience: ${key}. Valid: ${AUDIENCE_KEYS.join(', ')}`);
  }
  return profile;
}

module.exports = { AUDIENCE_PROFILES, AUDIENCE_KEYS, getAudienceProfile };
