# Lion Elite OS — AI Lead Intelligence Engine

## Status

**Top priority.** Build this system before lower-impact automation work.

## Mission

Generate high-quality business leads continuously using lawful, publicly available professional and business information.

Use AI to understand each prospect's business, likely goals, challenges, timing, and opportunities before any outreach. Equip human representatives with personalized research, conversation guidance, and recommended solutions so every interaction feels knowledgeable, trustworthy, relevant, and genuinely helpful.

Optimize every stage of the pipeline for:

- Better prospect qualification
- Faster research
- Personalized conversations
- Relationship building
- Higher conversion rates
- Long-term customer success
- Accurate, current CRM data

## Operating Principles

1. **Human supervised:** AI may discover, research, score, summarize, and draft. A human approves external outreach by default.
2. **Public business context only:** Collect information that is relevant to a legitimate business purpose from lawful, publicly accessible sources.
3. **Minimum necessary data:** Do not collect sensitive personal data or irrelevant household information. Do not use people-search sites to assemble personal dossiers.
4. **Source transparency:** Every material claim in a prospect profile should include a source URL, capture date, and confidence level.
5. **Freshness matters:** Store `last_verified_at`, source status, and an expiration policy for volatile fields.
6. **No invented facts:** AI must separate verified facts, reasonable inferences, and unknowns.
7. **Respect access rules:** Honor website terms, robots directives, rate limits, authentication boundaries, suppression lists, and applicable outreach laws.
8. **Relationship first:** Optimize for relevance and usefulness, not message volume.
9. **Auditability:** Log why a lead was selected, how it was scored, what sources were used, who approved outreach, and what happened afterward.
10. **Continuous learning:** Improve scoring using actual outcomes while preventing feedback loops that unfairly exclude new segments.

## AI Objectives

1. Continuously discover qualified businesses.
2. Verify, normalize, deduplicate, and organize public business information.
3. Build searchable business knowledge profiles.
4. Surface likely opportunities, needs, buying signals, and pain points.
5. Draft personalized outreach for human review.
6. Recommend discovery questions, talking points, objections, and next-best actions.
7. Learn from outcomes to improve lead scoring and prioritization.
8. Keep the CRM current automatically.
9. Detect stale records, bounced contacts, duplicates, conflicts, and ownership issues.
10. Measure business impact from source to retained customer.

## Initial Target Segments

The engine must support configurable ideal-customer profiles rather than one hard-coded audience. Initial segments may include:

- Gyms, fitness studios, trainers, coaches, and wellness businesses
- Med spas, aesthetic practices, skincare professionals, and beauty businesses
- Laboratories, research organizations, and qualified B2B research buyers where appropriate
- Affiliates, creators, influencers, and referral partners
- Real estate professionals, investors, operators, and service providers
- Strategic partners for BUNKER and other Lion Elite ventures

Each segment needs its own:

- Qualification rules
- Disqualifiers
- Approved value propositions
- Compliance boundaries
- Lead score weights
- Discovery questions
- Outreach templates
- Recommended offers

## End-to-End Pipeline

### 1. Define Campaign

Required fields:

- Brand
- Offer
- Ideal customer profile
- Geography
- Industry and subindustry
- Company size or maturity
- Required signals
- Exclusion rules
- Approved channels
- Daily volume cap
- Campaign owner
- Success metric

### 2. Discover

Use approved public sources such as:

- Official business websites
- Public professional profiles
- Business directories
- Government business registries
- Maps and local listings
- Public social business pages
- Trade associations
- Event exhibitor and sponsor lists
- Public job postings
- Public press releases and news
- Public reviews and business updates

Discovery output should create a provisional company record, never an outreach-ready record.

### 3. Verify and Normalize

For each record:

- Confirm business identity
- Resolve official website and domain
- Normalize company name, address, phone, industry, and location
- Validate business email domain when available
- Detect duplicates and parent-child relationships
- Record source, date, and confidence
- Mark conflicting information for review
- Exclude closed, irrelevant, prohibited, or unverifiable businesses

### 4. Enrich and Understand

Build a concise intelligence profile containing:

- What the business does
- Products and services
- Target customer
- Locations and service area
- Team size indicators
- Business model
- Positioning and differentiators
- Recent launches, hiring, expansion, events, or partnerships
- Public technology and platform signals when relevant
- Content themes and engagement signals
- Public customer feedback themes
- Likely goals
- Likely challenges
- Potential Lion Elite opportunity
- Risks or reasons not to contact

The profile must label each statement as:

- `verified`
- `inferred`
- `unknown`

### 5. Score and Prioritize

Recommended score components:

- ICP fit: 0–30
- Need or opportunity: 0–20
- Timing or intent signals: 0–15
- Reachability: 0–10
- Relationship or partnership potential: 0–10
- Data confidence: 0–10
- Strategic value: 0–5

Apply penalties for:

- Poor fit
- Stale data
- Missing official source
- Existing customer or active opportunity
- Prior opt-out
- Recent unsuccessful outreach
- Compliance or reputation risk
- Duplicate ownership

Every score must include a plain-language explanation.

### 6. Produce Representative Brief

Before a call or message, create a one-screen brief:

- Business summary
- Why this prospect was selected
- Three verified facts
- Two likely needs or opportunities
- Best opening angle
- Personalized value hypothesis
- Five discovery questions
- Relevant Lion Elite solution
- Likely objection and response guidance
- Recommended next step
- Sources and confidence
- Prohibited or unsupported claims to avoid

### 7. Draft Outreach

Drafts must:

- Reference only verified, relevant details
- Avoid pretending to know private goals or problems
- Be short, specific, respectful, and useful
- Match the brand and campaign
- Include a clear reason for contact
- Offer a low-friction next step
- Avoid medical, financial, or performance claims that are not approved
- Avoid manipulative urgency or deceptive personalization
- Require human approval before sending by default

### 8. CRM Sync and Workflow

Lifecycle stages:

- Discovered
- Verification pending
- Qualified
- Research complete
- Ready for review
- Approved for outreach
- Contacted
- Engaged
- Meeting booked
- Opportunity
- Customer
- Nurture
- Disqualified
- Suppressed

Automation should:

- Assign owners
- Create follow-up tasks
- Log outreach and responses
- Prevent duplicate contact
- Refresh stale records
- Flag missing next steps
- Track meetings, proposals, wins, losses, and retention
- Preserve source history and audit logs

### 9. Learn from Outcomes

Capture structured outcomes:

- Message approved, edited, or rejected
- Response sentiment
- Meeting booked
- Qualification result
- Objection category
- Offer presented
- Won or lost
- Loss reason
- Revenue
- Retention
- Expansion or referral

Use outcomes to recalibrate scoring, source quality, segment definitions, and message recommendations. Never allow the model to silently rewrite qualification policy.

## Core Data Model

### Company

- `company_id`
- `legal_name`
- `display_name`
- `domain`
- `industry`
- `subindustry`
- `description`
- `business_model`
- `employee_range`
- `locations`
- `service_area`
- `phone`
- `public_email`
- `social_profiles`
- `status`
- `source_records[]`
- `last_verified_at`
- `data_confidence`

### Contact

Store only role-relevant professional information:

- `contact_id`
- `company_id`
- `full_name`
- `job_title`
- `department`
- `professional_profile_url`
- `business_email`
- `business_phone`
- `source_records[]`
- `verification_status`
- `opt_out_status`
- `last_verified_at`

### Intelligence Profile

- `company_id`
- `verified_facts[]`
- `inferences[]`
- `unknowns[]`
- `buying_signals[]`
- `pain_point_hypotheses[]`
- `opportunities[]`
- `risks[]`
- `recommended_offer`
- `recommended_questions[]`
- `sources[]`
- `generated_at`
- `model_version`

### Lead and Opportunity

- `lead_id`
- `company_id`
- `contact_id`
- `campaign_id`
- `owner_id`
- `stage`
- `score_total`
- `score_breakdown`
- `score_explanation`
- `next_action`
- `next_action_at`
- `outcome`
- `revenue_value`
- `created_at`
- `updated_at`

## Search and User Experience

Representatives should be able to search and filter by:

- Brand
- Campaign
- Industry
- Geography
- Company size
- Score
- Opportunity type
- Buying signal
- Data confidence
- Owner
- Stage
- Last contacted
- Next action
- Source
- Freshness

Each profile should show:

- Executive summary
- Evidence and sources
- Timeline of signals
- Lead score explanation
- Recommended conversation plan
- CRM activity
- Approval status
- Data quality warnings

## Agent Roles

### Discovery Agent
Finds candidate businesses from approved sources and campaigns.

### Verification Agent
Resolves identity, validates fields, deduplicates, and grades confidence.

### Research Agent
Builds evidence-backed company intelligence profiles.

### Qualification Agent
Applies campaign rules and explains lead scores.

### Sales Copilot
Creates representative briefs, discovery questions, and next-best actions.

### Outreach Drafting Agent
Produces channel-specific drafts for human review.

### CRM Steward Agent
Maintains ownership, stages, tasks, freshness, and duplicate prevention.

### Learning and Analytics Agent
Analyzes source quality, funnel performance, edits, objections, wins, losses, and retention.

### Compliance Guard Agent
Checks source permissions, suppression status, prohibited data, approved claims, and channel rules before outreach.

## Human Approval Gates

Human review is required for:

- Activating a new target segment
- Approving a new data source
- Changing score weights or disqualifiers
- First outreach to a prospect unless an approved workflow explicitly allows otherwise
- High-risk claims or regulated-business messaging
- Bulk campaign activation
- Overrides of suppression, duplicate, or conflict warnings

## Success Metrics

### Acquisition

- Qualified leads per week
- Qualification acceptance rate
- Cost per qualified lead
- Source-to-qualified conversion

### Data Quality

- Verified-data rate
- Duplicate rate
- Conflict rate
- Bounce rate
- Freshness SLA compliance

### Engagement

- Human draft approval rate
- Average human edit distance
- Positive response rate
- Meeting-booked rate
- Time from discovery to approved outreach

### Revenue

- Opportunity conversion rate
- Customer conversion rate
- Revenue per source
- Sales cycle length
- Retention
- Expansion and referrals

### Productivity

- Research time saved
- CRM administration time saved
- Leads reviewed per representative
- Follow-up SLA compliance

## MVP Definition

The first release should:

1. Support one brand, one offer, and one ideal-customer profile.
2. Use two or three approved public business sources.
3. Create company records with citations and freshness timestamps.
4. Deduplicate by normalized name, domain, phone, and location.
5. Generate an intelligence profile with verified/inferred/unknown labels.
6. Produce an explainable lead score.
7. Generate a representative brief and one outreach draft.
8. Require human approval.
9. Sync stage, owner, next action, and outcome to the CRM.
10. Provide a dashboard for qualified leads, response rate, meetings, conversions, and time saved.

## MVP Acceptance Criteria

- At least 90% of approved leads have an official website or authoritative business source.
- Every material profile statement has a source or is clearly labeled as an inference.
- Duplicate rate after verification is below 3%.
- No suppressed lead can enter an outreach-ready stage.
- A representative can review a lead, sources, score, brief, and draft in one workflow.
- All outbound drafts are logged with approver and final edited copy.
- Funnel outcomes can be traced back to campaign and source.
- The system can refresh stale records without creating duplicates.

## Phased Roadmap

### Phase 1 — Foundation

- Campaign and ICP schema
- Source registry and approval policy
- Company/contact data model
- Verification and deduplication
- CRM stages and ownership
- Audit log

### Phase 2 — Intelligence

- Evidence-backed research profiles
- Explainable scoring
- Buying signals and opportunity hypotheses
- Search and filters

### Phase 3 — Sales Copilot

- Representative briefs
- Discovery questions
- Objection guidance
- Offer recommendations
- Human-reviewed outreach drafts

### Phase 4 — Automation

- Scheduled discovery
- Stale-record refresh
- Follow-up task automation
- CRM synchronization
- Alerts and dashboards

### Phase 5 — Learning

- Outcome analytics
- Source quality scoring
- Segment-level scoring calibration
- Draft edit analysis
- Retention and expansion recommendations

## Immediate Build Order

1. Select the first brand, offer, ICP, geography, and approved sources.
2. Implement the core data model and source audit trail.
3. Build verification, normalization, and deduplication.
4. Build the intelligence profile generator.
5. Add explainable lead scoring.
6. Build the human review queue and representative brief.
7. Add outreach drafting with approval gates.
8. Connect CRM lifecycle stages and next actions.
9. Add analytics and outcome learning.
10. Expand only after the MVP meets data-quality and conversion benchmarks.
