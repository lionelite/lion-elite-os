'use strict';

// Audience profiles for the Bluesky social-listening monitor.
//
// Two audiences, one per brand lane:
//  - research-peptides (Lion Elite Wellness): researchers and lab buyers
//    discussing sourcing, vendors, COAs, purity. Posts showing PERSONAL-USE
//    intent (dosing, injecting, cycles, "I'm on...") are surfaced but
//    hard-flagged DO NOT ENGAGE — marketing research-use-only products to
//    human-use intent is outside policy (docs/customer-communication-rules.md).
//  - personal-training (Lion Elite Beauty): people publicly asking for a
//    trainer/coach or how to start training. (The firehose exposes public
//    posts, not searches — a public "looking for a coach" post is the
//    equivalent signal.)
//
// This tool NEVER posts, replies, likes, follows, or DMs. It only surfaces
// posts, with a suggested opener a human may use manually after review.

const AUDIENCE_PROFILES = Object.freeze({
  'research-peptides': {
    key: 'research-peptides',
    brand: 'wellness',
    label: 'Researchers sourcing peptides (Lion Elite Wellness)',
    // At least one subject term is required.
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
    // At least one purchase/sourcing intent term is required.
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
    // Optional context that raises the score (research setting signals).
    boosterTerms: [
      'lab', 'laboratory', 'research', 'researcher', 'study', 'studies',
      'in vitro', 'in vivo', 'assay', 'cell culture', 'university',
      'coa', 'hplc', 'purity', 'batch', 'third-party tested', 'third party tested'
    ],
    // Human-use intent → surface but DO NOT ENGAGE.
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
    // Trainers advertising themselves are peers, not prospects.
    doNotEngagePatterns: [
      /\bi'?m\s+a\s+(certified\s+)?(personal\s+)?(trainer|coach)\b/i,
      /\bmy\s+clients?\b/i,
      /\baccepting\s+(new\s+)?clients\b/i,
      /\bdm\s+me\s+to\s+(train|start|sign)\b/i
    ],
    doNotEngageReason:
      'Author appears to be a trainer/coach advertising services (peer, not ' +
      'a prospect).',
    suggestedOpener:
      'If what you actually want is structure and real accountability — not ' +
      'another random plan — that is exactly what Lion Elite Beauty coaching ' +
      'is built around. lionelitebeauty.com'
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
