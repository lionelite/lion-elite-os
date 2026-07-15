# LionOS Platform Build Roadmap

## Objective

Build a unified Lion Elite operating system that connects lead acquisition, sales conversations, CRM workflows, follow-up, coach partnerships, business automation consulting, reporting, and executive oversight.

The platform must follow the governing sales principle:

> Diagnose before prescribing. The prospect should speak more than the salesperson, and every recommendation must connect directly to the prospect's stated goals, situation, timeline, and needs.

## Build Order

### Phase 1 — AI Sales Agent

#### Goal

Ensure every prospect receives the same discovery-first experience while giving the human representative clear guidance rather than replacing human judgment.

#### Core capabilities

- Deliver the appropriate power statement for the selected service.
- Establish credibility in under fifteen seconds.
- Ask dynamic discovery and clarifying questions.
- Identify the prospect's goals, obstacles, timeline, urgency, budget context, and decision process.
- Detect the likely communication style:
  - Performer
  - Analyzer
  - Controller
  - Empathizer
- Adjust question order, tone, detail, and pacing to the communication style.
- Track objections without arguing or prematurely overcoming them.
- Recommend only the solution supported by discovery.
- Generate the next best question or action.
- Create a structured conversation summary for the CRM.
- Require human approval before sending external messages by default.

#### Required output

```json
{
  "lead_score": 91,
  "communication_style": "Analyzer",
  "primary_goal": "Lose 40 pounds while maintaining strength",
  "primary_obstacle": "Lack of structure and accountability",
  "primary_objection": "Cost",
  "recommended_service": "Lion Elite Beauty VIP",
  "recommendation_reason": "The prospect requested individualized structure, accountability, and long-term support.",
  "next_best_question": "What would success look like six months from now?",
  "confidence": 0.88,
  "human_review_required": true
}
```

#### Acceptance criteria

- No recommendation is generated until minimum discovery requirements are satisfied.
- Every recommendation includes evidence from the prospect's own statements.
- The system can return `insufficient_information` instead of forcing a recommendation.
- Every AI-generated external message is reviewable before delivery.
- The conversation summary can be stored in the CRM without manual reformatting.

---

### Phase 2 — Universal CRM

#### Goal

Create one source of truth for every prospect, client, business, coach, referral partner, and opportunity.

#### Core record fields

- Contact identity and organization
- Lead source and campaign
- Assigned representative
- Lifecycle stage
- Lead and qualification scores
- Goals
- Obstacles
- Timeline
- Budget context
- Decision process
- Communication style
- Objections
- Recommended service
- Conversation history
- Last contact
- Next action
- Follow-up due date
- Consent, suppression, and channel permissions
- Source attribution and data freshness
- Closed-won value
- Lost reason
- Referral source
- Client success and expansion indicators

#### Standard pipeline

1. New Lead
2. Researching
3. Discovery
4. Qualified
5. Solution Presented
6. Follow-Up
7. Closed Won
8. Client Success
9. Referral / Expansion
10. Closed Lost

#### Automation rules

- Create a follow-up task after every meaningful interaction.
- Require a lost reason before closing an opportunity as lost.
- Flag stale records for review.
- Prevent duplicate contacts and businesses.
- Record every automated field change in an audit log.
- Never move a lead to `Qualified` without required discovery information.

#### Acceptance criteria

- A representative can understand the lead and next action from one screen.
- Duplicate business and contact records are detected before creation.
- Pipeline changes are explainable and auditable.
- Sales-agent output maps directly into CRM fields.

---

### Phase 3 — AI Follow-Up Engine

#### Goal

Generate timely, personalized, compliant follow-up drafts based on the actual conversation and opportunity stage.

#### Supported scenarios

- New inquiry response
- Missed appointment
- No response
- Price objection
- Need to think
- Financing discussion
- Information requested
- Proposal follow-up
- Referral request
- Client check-in
- Review request
- Renewal and expansion
- Re-engagement of stale qualified leads

#### Rules

- Use only verified conversation and CRM context.
- Never invent urgency, discounts, results, or prior statements.
- Match the prospect's communication style.
- Connect the message to the prospect's stated goal.
- Include one clear next step.
- Respect suppression lists, consent, channel rules, and communication frequency limits.
- Draft for human review by default.

#### Acceptance criteria

- Every draft identifies the triggering event and source context internally.
- The system can explain why the follow-up was recommended.
- Duplicate or excessive follow-ups are blocked.
- Opt-outs immediately prevent future outreach through the affected channel.

---

### Phase 4 — Lead Intelligence Dashboard

#### Goal

Give sales leadership a live view of pipeline health, activity, conversion, and risk.

#### Dashboard metrics

- New leads today, week, and month
- Qualified leads
- Meetings booked
- Show rate
- Presentation rate
- Close rate
- Revenue and pipeline value
- Average deal size
- Average sales cycle
- Conversion by source
- Conversion by representative
- Conversion by service
- Referral rate
- Follow-up completion rate
- Stale opportunities
- AI recommendation confidence
- Human approval and edit rate
- Data freshness and verified-data rate

#### Required views

- Executive summary
- Representative performance
- Campaign performance
- Pipeline stage breakdown
- Source attribution
- Follow-up queue
- Data quality and compliance

#### Acceptance criteria

- Metrics have documented definitions.
- Users can filter by date, representative, source, service, and stage.
- Every metric links to the underlying records.
- Dashboard totals reconcile with CRM data.

---

### Phase 5 — Coach Partnership Portal

#### Goal

Give approved coaches and partners a professional portal for referrals, commissions, education, and collaboration.

#### Partner capabilities

- Unique referral link and code
- Referral and conversion tracking
- Commission statement
- Payout history
- Pending and approved commissions
- Marketing assets
- Approved educational content
- Sales and compliance training
- Partnership documents
- Support requests
- Performance metrics
- Leaderboard where appropriate

#### Administrative capabilities

- Partner application review
- Qualification status
- Agreement acceptance
- Revenue-share configuration
- Commission adjustments with audit trail
- Payout approval
- Referral dispute handling
- Content and compliance controls

#### Rules

- Commission terms must be explicit and versioned.
- Referral attribution rules must be documented.
- Manual adjustments require a reason and audit record.
- Partners may only access their own referrals and financial information.
- Product and service messaging must use approved language.

#### Acceptance criteria

- A partner can independently understand each referral's status.
- Administrators can trace every commission calculation.
- Role-based access prevents cross-partner data exposure.

---

### Phase 6 — Business AI Scaling Platform

#### Goal

Diagnose operational inefficiency and produce a grounded automation and scaling roadmap for business clients.

#### Discovery categories

- Business model and revenue streams
- Team structure and responsibilities
- Lead generation and sales
- Customer onboarding
- Client service and retention
- Administrative workload
- Tools and software
- Reporting and decision-making
- Repetitive manual work
- Bottlenecks and error-prone processes
- Financial impact
- Implementation readiness

#### Platform outputs

- Automation audit
- Current-state process map
- Time-loss analysis
- Administrative cost estimate
- Revenue opportunity analysis
- Recommended automation roadmap
- Priority ranking by impact, effort, risk, and dependency
- Proposed implementation phases
- ROI assumptions and estimate
- Client-ready proposal
- Sales presentation outline

#### Rules

- Separate verified facts from assumptions.
- Label all estimates and show calculation inputs.
- Do not promise guaranteed savings or revenue.
- Recommend human review for high-risk or customer-facing automations.
- Identify security, privacy, compliance, and integration dependencies.

#### Acceptance criteria

- Every recommendation maps to a discovered problem.
- ROI estimates are reproducible.
- The client can see what should be implemented first and why.
- The system can decline to estimate when required data is missing.

---

### Phase 7 — Executive Command Center

#### Goal

Create one homepage for leadership to understand performance, priorities, risk, and progress across Lion Elite.

#### Command-center modules

- Revenue today, week, month, and quarter
- Sales pipeline
- New and qualified leads
- Meetings and follow-ups
- Client retention and expansion
- Partner referrals and commissions
- Marketing campaign performance
- AI automation health
- GitHub development progress
- Operational tasks and blockers
- Lion Elite Wellness
- Lion Elite Beauty
- BUNKER
- Real Estate
- Compliance and data-quality alerts

#### Acceptance criteria

- Each summary links to the operational system of record.
- Access is controlled by role.
- Alerts identify the owner and required action.
- Executive metrics use the same definitions as detailed dashboards.

## Shared Platform Architecture

### Core services

- Identity and role-based access control
- CRM and relationship graph
- Conversation and activity timeline
- Lead intelligence and scoring
- AI sales guidance
- Follow-up orchestration
- Partner and commission service
- Analytics and reporting
- Notification service
- Consent and suppression service
- Audit logging
- Integration layer

### Required roles

- Executive
- Administrator
- Sales manager
- Sales representative
- Coach / partner
- Client
- Analyst
- Read-only auditor

### Shared standards

- Human approval for external AI communication by default.
- Least-privilege access.
- Full audit history for sensitive changes.
- Explainable scoring and recommendations.
- Source attribution and freshness timestamps.
- Data minimization and documented retention.
- Encryption in transit and at rest.
- Idempotent external actions.
- Fail-closed behavior for consent and compliance checks.
- Monitoring, error reporting, and recovery procedures.

## Initial Data Model

### Primary entities

- `users`
- `roles`
- `organizations`
- `contacts`
- `leads`
- `opportunities`
- `activities`
- `conversations`
- `discovery_answers`
- `recommendations`
- `tasks`
- `campaigns`
- `consents`
- `suppressions`
- `partners`
- `referrals`
- `commission_rules`
- `commissions`
- `payouts`
- `clients`
- `services`
- `proposals`
- `automation_audits`
- `metrics`
- `audit_events`

## First Implementation Milestone

The first working milestone should include:

1. Lead and contact records.
2. Standard pipeline stages.
3. Structured discovery questionnaire.
4. AI-generated conversation summary.
5. Evidence-based service recommendation.
6. Next-best-question generation.
7. Follow-up task creation.
8. Human-reviewed follow-up draft.
9. Basic sales dashboard.
10. Audit events for AI recommendations and CRM changes.

## Definition of Done

The platform is not considered complete because a screen exists. A feature is complete only when:

- The user workflow functions from beginning to end.
- Permissions are enforced.
- Validation and failure behavior are defined.
- Audit events are recorded.
- Automated tests cover critical behavior.
- Documentation explains setup and operation.
- Metrics confirm whether the feature improves performance.
