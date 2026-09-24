# Lion Elite Wellness — Affiliate Revenue Engine v1

## Mission

Build the smallest production-capable affiliate system that turns qualified partner candidates into attributable revenue, then learns which partner profiles produce repeatable sales.

Primary business outcome:

`qualified candidate -> recruited -> onboarded -> activated -> first attributable sale -> repeat attributable revenue`

The system must reuse existing Lion Elite OS lead intelligence, outreach validation, affiliate/rep, checkout attribution, revenue event, and reporting components wherever they are already verified. Do not create parallel stores of truth.

## Research-derived operating model

This structure is based on current affiliate/partner-management practice from Shopify, Refersion, PartnerStack, FTC endorsement guidance, and current platform disclosure requirements:

- Start simple with one clear program and measurable goals.
- Recruit selectively; screen for fit, promotion plan, audience quality, prior brand experience, and credibility rather than raw follower count.
- Treat activation as its own stage: approved affiliates need onboarding, tracking links/codes, content resources, expectations, and a first-sale path.
- Centralize links, performance, resources, commission terms, and payout status in the affiliate portal.
- Track performance by affiliate, offer, asset, and SKU/product where data exists.
- Delay payout approval until order validity/chargeback risk is known; monitor unusual conversion behavior.
- Require clear, conspicuous disclosure of the material relationship; train and monitor affiliates.
- Platform-specific branded-content disclosures remain the affiliate's responsibility and must be included in onboarding guidance.

Reference material used for the operating model:

- Shopify, "How to Start an Affiliate Program" (2026): https://www.shopify.com/blog/53669701-how-to-set-up-an-affiliate-program-for-your-shopify-store
- Shopify, "Affiliate Commission Guide" (2026): https://www.shopify.com/blog/affiliate-commission
- Refersion, affiliate program best practices/reporting/fraud prevention: https://support.refersion.com/en/collections/2671516-best-practices , https://support.refersion.com/en/articles/4708340/how-to-use-reports , https://support.refersion.com/en/articles/2569588-identifying-preventing-and-stopping-affiliate-fraud
- PartnerStack activation guidance: https://partnerstack.com/platform/activate-partners
- FTC Endorsement Guides FAQ: https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides-what-people-are-asking
- YouTube paid promotion policy: https://support.google.com/youtube/answer/154235
- TikTok commercial content disclosure guidance: https://ads.tiktok.com/resources/help/article/tiktok-one-policies

## Non-negotiable Lion Elite operating rules

1. Revenue before features.
2. `verified`, `degraded`, `broken`, `unproven` must be explicit for every subsystem.
3. Missing/unwired data is missing/unproven, never zero.
4. Manual human response suppresses automated follow-up.
5. No uncontrolled bulk outreach.
6. LEW remains research-only: no human-use, dosing, administration, reconstitution, treatment, disease, transformation, or guaranteed-result claims in affiliate assets.
7. Affiliate disclosure must be clear and conspicuous.
8. No invented conversion rates, EV, CAC, ROI, revenue, or audience data.
9. Attribution and payout logic must be idempotent and auditable.
10. A merged PR is not business proof. Production proof requires a real attributable sale.

## System architecture

### 1. Candidate discovery and qualification

Reuse the existing lead intelligence / public-business discovery pipeline, but introduce `affiliate_candidate` as a distinct intent and lifecycle rather than overloading generic lead stages.

Candidate target profiles:

- fitness/bodybuilding coaches and creators
- strength/physique trainers
- gym owners/operators
- research/wellness creators whose public audience is relevant to LEW's research positioning
- existing customers/referrers with proven organic influence where consent and policy permit

Store only authorized/public business contact paths and source evidence.

Candidate fields:

- immutable candidate id
- display name / business or creator name
- candidate type
- source and source URL
- public/authorized contact channels
- channel/media properties
- audience-fit evidence
- engagement/selling evidence if actually observed
- brand/competitor conflicts if known
- freshness timestamp
- owner
- lifecycle stage
- next action
- suppression / do-not-contact state
- qualification rationale
- score components, never opaque-only score

Lifecycle:

`PROSPECT -> CONTACTABLE -> OUTREACH_READY -> REPLIED -> QUALIFIED -> ONBOARDED -> ACTIVATED -> FIRST_SALE -> PRODUCING`

Terminal states:

`DECLINED`, `DISQUALIFIED`, `DO_NOT_CONTACT`, `SUSPENDED`, `INACTIVE`

### 2. Explainable candidate scoring

Use a bounded score composed only from evidence actually present:

- audience fit
- promotion/sales evidence
- engagement quality where measured
- public contactability
- source confidence
- freshness
- conflict/risk penalty

Do not infer private demographics or sensitive traits. Do not treat follower count as a primary success signal. Missing inputs stay missing and reduce confidence rather than being imputed.

### 3. Recruitment workbench

Owner-visible queue ordered by priority and freshness.

Each row must show:

- who they are
- why they fit
- evidence/source
- authorized contact path
- current stage
- owner
- next action
- age/freshness
- blocker
- prior touches
- suppression state

The system may prepare compliant outreach drafts for human review. Existing consent, suppression, frequency, and manual-reply stop logic must remain authoritative.

### 4. Affiliate application / screening

Approved recruitment/application intake should capture:

- public media properties
- primary audience and content type
- how they plan to promote
- prior affiliate/brand experience
- competing partnerships where relevant
- acknowledgment of LEW research-only communication rules
- acknowledgment of FTC/platform disclosure duties
- payment/tax setup status without exposing sensitive data in logs

Applications are manually or policy-approved; no auto-approval solely from follower count.

### 5. One-command provisioning

Target operator workflow:

`Create affiliate: NAME | CODE`

Provisioning should reuse authoritative affiliate/rep infrastructure and create/attach:

- affiliate identity
- normalized unique code
- tracked referral link
- portal access/invite
- commission plan id
- attribution source id
- payout status container
- compliance/training acknowledgment

No one-off hard-coded affiliate branches.

### 6. Affiliate portal

The portal should prioritize activation and revenue, not decoration.

Affiliate sees:

- unique link and code
- approved research-only brand/creative assets
- required disclosure language/examples
- prohibited claims summary
- attributable orders/conversions after approval
- approved commission earnings
- pending/held/paid status
- current commission terms
- payout history
- announcements/resources
- first-sale checklist

Owner/admin sees:

- candidates by stage
- affiliates by activation state
- days to activation
- first-sale status
- attributed gross/net revenue where verified
- product/SKU performance where wired
- repeat revenue
- refunds/chargebacks/held commissions
- payout liability
- top producing affiliates
- inactive affiliates needing re-engagement
- compliance/risk flags

### 7. Activation playbook

An affiliate is not `ACTIVATED` merely because an account exists.

Activation requires all of:

- portal access confirmed
- tracking link/code issued
- terms/compliance acknowledged
- at least one approved promotional method/content path selected
- first action completed (for example approved content asset downloaded or launch plan recorded)

First-sale playbook:

1. onboarding complete
2. choose promotion channel
3. choose approved asset/message framework
4. publish/send under platform and disclosure rules
5. verify attributable click/code usage if tracking exists
6. verify real order
7. verify exactly one revenue event
8. move affiliate to `FIRST_SALE`
9. re-engage with next approved promotion based on actual performance

### 8. Attribution

Canonical attribution precedence must be explicit and tested.

Persist affiliate identity/code/link through:

`entry/referral -> cart/checkout intent -> provider metadata -> order/payment -> exactly one revenue event -> affiliate conversion -> commission record -> reporting`

Requirements:

- integer-cent money math
- idempotency key per provider/order/conversion
- repeat-purchase detection
- no inference when attribution is absent
- refunds/cancellations/chargebacks reverse or hold commission according to configured rules
- manual adjustments are audited

### 9. Commission engine

Commission is configuration, not hard-coded percentages.

Support:

- plan/version id
- percentage or fixed amount if the business later chooses
- optional product-specific economics
- effective date
- approval/hold period
- reversal rules
- performance tiering only when backed by measured production

Do not bake a speculative rate into code. Business economics must be supplied by the owner and validated against actual margin data before production payout rules change.

### 10. Fraud/risk controls

Before commission approval, flag:

- self-referral or obvious related-party anomalies where detectable lawfully
- duplicate conversions
- unusual click-to-order patterns when clicks are actually measured
- rapid high-value first orders
- refunded/charged-back orders
- coupon leakage where attribution policy says it should not count
- banned/suspended affiliate activity

New affiliates may have commissions held until the order-validity window passes. Fraud flags require review; do not auto-accuse affiliates.

### 11. Compliance controls

Affiliate onboarding must include:

- FTC material-connection disclosure requirement
- platform disclosure reminder for TikTok/YouTube/Instagram or other channels used
- research-only LEW messaging boundary
- prohibited claims list
- acknowledgement/version timestamp

Every approved asset should have:

- asset id/version
- allowed channels
- research disclaimer state
- approval timestamp
- retired/replaced status

### 12. Metrics

P0 scoreboard:

- candidates discovered
- candidates contactable
- outreach-ready
- replies
- qualified
- onboarded
- activated
- first-sale affiliates
- producing affiliates
- attributable orders
- attributable revenue
- repeat attributable revenue
- time candidate -> activation
- time activation -> first sale
- revenue per producing affiliate
- refunds/chargebacks affecting affiliate revenue

Only render a metric when its data path is wired. Otherwise render `UNPROVEN` or `NOT WIRED`.

## Step-by-step implementation plan

### Phase 0 — Reuse audit

Before coding, produce a component map of existing lead, outreach, affiliate/rep, checkout, revenue-attribution, commission/payout, and portal code. Classify each component as `verified`, `degraded`, `broken`, or `unproven` with file paths, tests, and production evidence.

### Phase 1 — Durable candidate lifecycle

Implement schema/model/service/API for affiliate candidates and lifecycle transitions. Connect existing discovery outputs to `affiliate_candidate` without breaking generic leads. Add owner-visible queue and tests.

Exit proof: a real public-business/creator candidate can enter the queue with source evidence, owner, next action, freshness, and suppression state.

### Phase 2 — Recruitment workbench

Add explainable ranking, compliant draft generation, contact eligibility checks, and outcome logging. Manual send remains default until existing delivery gates are independently proven.

Exit proof: one real candidate can be moved from `PROSPECT` to `QUALIFIED` with an auditable interaction trail.

### Phase 3 — Provisioning + portal activation

Generalize existing rep/affiliate provisioning into configuration-driven workflow and portal. Remove one-off affiliate-specific branches where safe.

Exit proof: one approved candidate becomes an affiliate with working portal access, unique tracking code/link, terms/compliance acknowledgment, and first-sale checklist.

### Phase 4 — Attribution + commission proof

Wire affiliate identity through checkout/provider/revenue event/conversion/commission reporting. Reuse the existing revenue-event store and provider ingestion where verified.

Exit proof: test fixture proves idempotent attribution, then one real production order proves end-to-end attribution without duplicate revenue events.

### Phase 5 — Performance and fraud controls

Add affiliate/SKU/asset reporting, payout holds, reversals, anomaly review, and inactive-affiliate re-engagement queue.

Exit proof: owner can see producing vs inactive affiliates, pending vs approved commission, and any order reversals without manual spreadsheet reconciliation.

### Phase 6 — Learn and scale

Use real production outcomes to improve candidate scoring. No model adjustment is kept unless it improves a measured KPI and does not worsen compliance/reliability.

Scale target: 3–5 productive affiliates, then use the observed characteristics of actual producers to prioritize the next recruitment cohort.

## Definition of done

The engine is not done when code is merged. v1 is production-proven only when:

1. one new affiliate is recruited through the tracked lifecycle;
2. onboarding and activation are recorded;
3. a real customer order carries that affiliate's attribution;
4. exactly one revenue event and one commission record are created;
5. the owner dashboard displays the attributable dollars and next action;
6. refund/reversal behavior is tested;
7. all relevant CI and production verification checks pass.
