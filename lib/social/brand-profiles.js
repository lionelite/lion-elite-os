'use strict';

// Brand profiles for the daily social content engine (Issue #48, Phase 1).
// Voice and pillars come from marketing/content-os/content-bible.md; the
// Lion Elite Wellness compliance posture comes from
// docs/customer-communication-rules.md — research-use-only, no dosing, no
// human-use instructions, no treatment claims, no transformation promises.

const WELLNESS_DISCLAIMER =
  'For laboratory research purposes only. Not for human or veterinary use.';

const BRAND_PROFILES = Object.freeze({
  wellness: {
    key: 'wellness',
    name: 'Lion Elite Wellness',
    website: 'lionelitewellness.com',
    complianceMode: 'research-only',
    disclaimer: WELLNESS_DISCLAIMER,
    voice: ['confident', 'calm', 'educated', 'direct', 'premium'],
    feedType: 'educational_feed',
    hashtags: [
      '#ResearchEducation',
      '#PeptideResearch',
      '#ScientificLiteracy',
      '#LabStandards',
      '#LionEliteWellness'
    ],
    // CTA rotation required by Issue #48: website, product education,
    // affiliate program, wholesale inquiries.
    ctaRotation: [
      {
        key: 'website',
        text: 'Explore the research catalog at lionelitewellness.com.'
      },
      {
        key: 'product_education',
        text: 'Read the product information pages to learn how we document quality.'
      },
      {
        key: 'affiliate',
        text: 'Interested in partnering? Ask about the Lion Elite Wellness affiliate program.'
      },
      {
        key: 'wholesale',
        text: 'Sourcing for a lab or research team? Reach out about wholesale inquiries.'
      }
    ],
    // Research-education topic pool. Every topic is about the research
    // product space itself — quality, documentation, literacy — never
    // about outcomes in people.
    topics: [
      {
        slug: 'how-to-read-a-coa',
        title: 'How to read a Certificate of Analysis',
        hook: 'A Certificate of Analysis is the receipt science asks for.',
        points: [
          'A COA documents identity and purity testing for a specific batch.',
          'Look for the testing method, the batch number, and the date.',
          'If a supplier cannot produce one, that is your answer.'
        ],
        visual: 'clean lab bench, printed COA document, minimal premium styling'
      },
      {
        slug: 'research-use-only-labeling',
        title: 'What "research use only" actually means',
        hook: 'Three words on a label carry an entire standard.',
        points: [
          'Research-use-only products are supplied for laboratory research.',
          'Clear labeling protects the researcher and the supplier.',
          'Responsible vendors say what a product is for — and what it is not for.'
        ],
        visual: 'labeled vials on a laboratory shelf, black and white premium look'
      },
      {
        slug: 'purity-testing-methods',
        title: 'How purity is verified in the lab',
        hook: 'Purity is a measurement, not a marketing word.',
        points: [
          'HPLC and mass spectrometry are the standard verification methods.',
          'A purity percentage without a method behind it is just a number.',
          'Ask what was tested, how, and by whom.'
        ],
        visual: 'HPLC instrument close-up, clean laboratory environment'
      },
      {
        slug: 'peptide-storage-handling',
        title: 'Storage and handling standards in research settings',
        hook: 'How a material is stored decides whether it is still the material.',
        points: [
          'Lyophilized research peptides are stable when kept cold, dry, and sealed.',
          'Temperature logs and handling records are part of good lab practice.',
          'Documentation is what separates a supply chain from a guess.'
        ],
        visual: 'laboratory freezer, organized sample storage, earth-tone minimal'
      },
      {
        slug: 'why-lyophilization',
        title: 'Why research peptides are lyophilized',
        hook: 'Freeze-drying is the reason a fragile molecule can travel.',
        points: [
          'Lyophilization removes water to stabilize peptides for storage.',
          'It preserves structure so laboratories receive consistent material.',
          'It is a quality decision, not a cosmetic one.'
        ],
        visual: 'lyophilized powder vial macro shot, studio lighting'
      },
      {
        slug: 'evaluating-supplier-standards',
        title: 'How to evaluate a research supplier',
        hook: 'The supplier sets the ceiling on your research quality.',
        points: [
          'Batch-specific testing, clear labeling, and traceability are the baseline.',
          'Professional language is a signal — hype is a red flag.',
          'Consistency across orders matters more than a single good batch.'
        ],
        visual: 'organized fulfillment area, clean packaging, premium minimal'
      },
      {
        slug: 'preclinical-vs-clinical',
        title: 'Preclinical vs. clinical: reading research honestly',
        hook: 'A cell study and an approved therapy are separated by years of work.',
        points: [
          'Preclinical research happens in laboratory models, not in patients.',
          'Interesting early findings are the start of a question, not an answer.',
          'Scientific literacy means knowing which stage a study belongs to.'
        ],
        visual: 'research journal on a desk, reading glasses, warm natural light'
      },
      {
        slug: 'reading-a-study-abstract',
        title: 'How to read a study abstract in 60 seconds',
        hook: 'Most claims fall apart in the methods section.',
        points: [
          'Check the model: cells, animal models, or human trials.',
          'Check the sample size and whether there was a control.',
          'The conclusion sentence is written to be quoted — read past it.'
        ],
        visual: 'highlighted journal article, coffee, disciplined morning desk scene'
      },
      {
        slug: 'cold-chain-logistics',
        title: 'Cold chain: the invisible part of research quality',
        hook: 'Quality can be lost in transit and no one would see it happen.',
        points: [
          'Temperature-sensitive materials need cold-chain shipping discipline.',
          'Insulated packaging and fast transit protect material integrity.',
          'A serious supplier treats logistics as part of the product.'
        ],
        visual: 'insulated shipping box with cold packs, clean studio product shot'
      },
      {
        slug: 'lab-documentation-standards',
        title: 'Documentation standards separate serious labs',
        hook: 'If it was not written down, it did not happen.',
        points: [
          'Batch records, receiving logs, and storage logs build traceability.',
          'Good documentation makes research repeatable.',
          'The habit of recording is the habit of rigor.'
        ],
        visual: 'lab notebook and pen, black and white, minimal luxury'
      },
      {
        slug: 'research-vendor-red-flags',
        title: 'Red flags when evaluating research vendors',
        hook: 'The louder the promises, the fewer the documents.',
        points: [
          'No batch testing, no COA, no clear labeling — walk away.',
          'Medical claims on a research product are a compliance failure.',
          'Professional vendors educate; they do not promise.'
        ],
        visual: 'magnifying glass over paperwork, investigative premium tone'
      },
      {
        slug: 'research-terminology-glossary',
        title: 'Research terminology, translated',
        hook: 'Scientific literacy starts with vocabulary.',
        points: [
          'In vitro means in glass — cell and tissue studies in the lab.',
          'In vivo means in a living model, still preclinical.',
          'Knowing the terms lets you read the research yourself.'
        ],
        visual: 'chalkboard-style typographic layout, earth tones'
      },
      {
        slug: 'what-peptides-are',
        title: 'What peptides actually are',
        hook: 'Short chains of amino acids — that is the whole definition.',
        points: [
          'Peptides are sequences of amino acids, smaller than proteins.',
          'They are studied across many fields of laboratory research.',
          'Understanding the chemistry keeps the conversation honest.'
        ],
        visual: 'molecular structure illustration, clean scientific aesthetic'
      },
      {
        slug: 'quality-over-hype',
        title: 'A higher standard for the research space',
        hook: 'The research product space has a hype problem. Standards fix it.',
        points: [
          'Clear labels, professional language, and quality documentation.',
          'Education builds trust; exaggeration destroys it.',
          'Lion Elite Wellness exists to raise the standard.'
        ],
        visual: 'brand flat-lay, black and white premium, lion motif subtle'
      },
      {
        slug: 'batch-traceability',
        title: 'Batch numbers: small print, big deal',
        hook: 'A batch number is a promise that someone can trace the answer.',
        points: [
          'Batch identifiers link a vial to its specific test results.',
          'Traceability means problems can be found, scoped, and answered.',
          'No batch number, no accountability.'
        ],
        visual: 'macro shot of a batch label on a vial, premium studio lighting'
      },
      {
        slug: 'third-party-testing',
        title: 'Why third-party testing matters',
        hook: 'A supplier grading its own homework is not a quality system.',
        points: [
          'Independent laboratories remove the conflict of interest.',
          'Third-party results should match the supplier’s claims.',
          'Verification you can check beats reputation you have to trust.'
        ],
        visual: 'independent lab exterior and paperwork, documentary style'
      }
    ]
  },

  beauty: {
    key: 'beauty',
    name: 'Lion Elite Beauty',
    website: 'lionelitebeauty.com',
    complianceMode: 'coaching',
    disclaimer: '',
    voice: ['confident', 'disciplined', 'direct', 'premium', 'never hype-only'],
    feedType: 'transformation_feed',
    hashtags: [
      '#LionEliteBeauty',
      '#DisciplineDaily',
      '#Biomarkers',
      '#WellnessCoaching',
      '#HigherStandard'
    ],
    // CTA rotation required by Issue #48: DM ELITE, comment READY,
    // program application.
    ctaRotation: [
      {
        key: 'dm_elite',
        text: 'DM ELITE if you are ready to build with purpose.'
      },
      {
        key: 'comment_ready',
        text: 'Comment READY and we will send you the first step.'
      },
      {
        key: 'program_application',
        text: 'Apply for the coaching program — the link is in our bio.'
      }
    ],
    topics: [
      {
        slug: 'stop-guessing-start-testing',
        title: 'Stop guessing. Start testing.',
        hook: 'Most people are not failing from low motivation. They are failing because they are guessing.',
        points: [
          'Guessing with training, nutrition, recovery, and health data.',
          'Biomarkers replace guesswork with objective feedback.',
          'Build from foundation, data, and discipline.'
        ],
        visual: 'lab report beside training shoes, morning light, premium minimal'
      },
      {
        slug: 'discipline-beats-motivation',
        title: 'Discipline beats motivation',
        hook: 'Motivation shows up sometimes. Discipline shows up daily.',
        points: [
          'Systems outlast feelings.',
          'The standard is what you do on the days you do not feel like it.',
          'Small non-negotiables compound into transformation.'
        ],
        visual: 'pre-dawn training environment, black and white, solitary athlete'
      },
      {
        slug: 'foundation-first',
        title: 'Foundation first',
        hook: 'Before optimization, there has to be a foundation.',
        points: [
          'Sleep, sunlight, hydration, minerals, whole foods, training, recovery.',
          'The body is already powerful — support it, do not fight it.',
          'Then use objective feedback to refine the plan.'
        ],
        visual: 'sunrise over mountains, nature and training merged, earth tones'
      },
      {
        slug: 'body-feedback-signals',
        title: 'Your body gives feedback every day',
        hook: 'Energy. Sleep. Recovery. Strength. Mood. Cravings.',
        points: [
          'The signals are already there — the question is whether you track them.',
          'Structured check-ins turn signals into decisions.',
          'Awareness is the first upgrade.'
        ],
        visual: 'journal with tracked metrics, watch, coffee, disciplined desk'
      },
      {
        slug: 'ninety-day-standard',
        title: 'The 90-day standard',
        hook: 'Ninety days of structure changes more than two years of dabbling.',
        points: [
          'A defined window creates urgency and honest measurement.',
          'Weekly structure beats daily improvisation.',
          'Commit to the window, then review the data.'
        ],
        visual: 'calendar with training blocks marked, clean flat-lay'
      },
      {
        slug: 'accountability-gap',
        title: 'The accountability gap',
        hook: 'Most plans do not fail from bad information. They fail alone.',
        points: [
          'Accountability is a structure, not a personality trait.',
          'Weekly check-ins keep the plan honest.',
          'Coaching closes the gap between knowing and doing.'
        ],
        visual: 'coach and client reviewing progress, professional setting'
      },
      {
        slug: 'data-driven-checkins',
        title: 'What a data-driven check-in looks like',
        hook: 'Feelings lie week to week. Trends do not.',
        points: [
          'Track sleep, training, nutrition adherence, and recovery markers.',
          'Review trends weekly, adjust one variable at a time.',
          'Objective feedback keeps emotion out of the decision.'
        ],
        visual: 'dashboard of wellness metrics on screen, minimal premium'
      },
      {
        slug: 'recovery-is-training',
        title: 'Recovery is part of training',
        hook: 'You do not get stronger in the session. You get stronger in the recovery.',
        points: [
          'Sleep and stress management are performance inputs.',
          'Under-recovered is the most common state we see.',
          'Plan recovery with the same discipline as training.'
        ],
        visual: 'rest day scene, nature, stretching at sunset'
      },
      {
        slug: 'executive-energy',
        title: 'Energy is the executive advantage',
        hook: 'High performers do not have more hours. They have more usable energy.',
        points: [
          'Energy management is built on sleep, training, and data.',
          'A structured wellness plan is a business asset.',
          'Lead yourself first.'
        ],
        visual: 'professional in gym before work, city skyline, premium tone'
      },
      {
        slug: 'natural-first-not-anti-science',
        title: 'Natural first is not anti-science',
        hook: 'It means respecting the foundation first.',
        points: [
          'Sunlight, sleep, hydration, minerals, whole foods, training.',
          'Then objective feedback to refine the plan.',
          'Optimization with respect for the body.'
        ],
        visual: 'ocean and forest imagery, grounded natural aesthetic'
      },
      {
        slug: 'identity-shift',
        title: 'Become the person the goal requires',
        hook: 'The transformation is who you become, not just how you look.',
        points: [
          'Standards change before results do.',
          'Identity is built through kept promises to yourself.',
          'The plan is the practice of becoming.'
        ],
        visual: 'mirror reflection in training environment, black and white'
      },
      {
        slug: 'weekly-non-negotiables',
        title: 'Pick your weekly non-negotiables',
        hook: 'You do not need a perfect week. You need a repeatable one.',
        points: [
          'Choose the training, sleep, and nutrition floors you will not break.',
          'Consistency at the floor beats intensity at the ceiling.',
          'Review and raise the floor monthly.'
        ],
        visual: 'simple checklist, pen, clean desk, morning discipline'
      },
      {
        slug: 'plateau-protocol',
        title: 'What to audit when progress stalls',
        hook: 'A plateau is information, not failure.',
        points: [
          'Audit sleep, stress, adherence, and training load — in that order.',
          'Most stalls are recovery problems wearing a nutrition costume.',
          'Change one variable, measure, repeat.'
        ],
        visual: 'flat progress chart turning upward, analytical premium look'
      },
      {
        slug: 'client-journey-structure',
        title: 'What structured coaching actually looks like',
        hook: 'Assessment. Plan. Check-ins. Adjustments. Accountability.',
        points: [
          'It starts with understanding where you are today.',
          'Objective feedback drives every adjustment.',
          'Structure is the service.'
        ],
        visual: 'coaching roadmap graphic, five steps, brand colors'
      },
      {
        slug: 'environment-design',
        title: 'Design the environment, not just the plan',
        hook: 'Willpower loses to environment every single time.',
        points: [
          'Make the right choice the easy choice — prep, layout, defaults.',
          'Remove the friction between you and the standard.',
          'Your surroundings vote on your habits daily.'
        ],
        visual: 'organized kitchen and gym bag laid out the night before'
      },
      {
        slug: 'sleep-is-a-skill',
        title: 'Sleep is a trainable skill',
        hook: 'The most underrated performance tool is free and happens in the dark.',
        points: [
          'Consistent timing, cool room, morning light — the fundamentals win.',
          'Recovery quality shows up in training quality.',
          'Track it like you track training.'
        ],
        visual: 'dark minimal bedroom, watch on nightstand, dawn light'
      }
    ]
  }
});

const BRAND_KEYS = Object.freeze(Object.keys(BRAND_PROFILES));

function getBrandProfile(key) {
  const profile = BRAND_PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown brand profile: ${key}. Valid keys: ${BRAND_KEYS.join(', ')}`);
  }
  return profile;
}

module.exports = {
  BRAND_PROFILES,
  BRAND_KEYS,
  WELLNESS_DISCLAIMER,
  getBrandProfile
};
