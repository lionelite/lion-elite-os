# Lion Elite Revenue Operating System (LROS)

## Mission

Build a measurable system that creates qualified opportunities, converts them into customers, increases repeat purchases, and produces revenue every day.

The primary company KPI is:

> Revenue every day.

Repositories, agents, automations, prompts, dashboards, and content are supporting assets—not outcomes.

## Non-Negotiable Completion Standard

No revenue-related system is considered complete until it produces a verified business output in production.

Examples of verified outputs:

- A usable lead with name and at least one valid contact method
- A booked sales call
- A completed order with attributable source
- A recovered abandoned cart
- A repeat purchase
- An activated affiliate or wholesale account
- A measurable increase in conversion, retention, or customer lifetime value

Code merged without a verified output is implementation progress, not completion.

## Revenue Architecture

### 1. Acquisition Engine

Bring qualified prospects into Lion Elite from multiple independent sources:

- Existing customers
- Referrals
- B2B outbound to med spas, wellness clinics, gyms, chiropractors, and related businesses
- Email outreach
- Social outreach
- Search and educational content
- Paid acquisition after attribution is verified
- Affiliates and strategic partnerships

Every source must write to a shared lead store using a common schema.

### 2. Lead Intelligence Engine

Minimum lead record:

- Lead ID
- Created timestamp
- Name or business name
- Email
- Phone
- Website
- Social profile
- Company type
- Geographic market
- Source
- Product/service interest
- Lead score
- Consent/contact basis when applicable
- Last contact
- Next action date
- Owner
- Status

A prospect without usable contact information must be labeled `research-only` and must not count toward qualified lead KPIs.

### 3. Sales Execution Engine

Every qualified lead must have:

- A defined offer
- A responsible owner
- A next action
- A follow-up date
- A complete contact history

No lead may remain in an undefined state.

Recommended lifecycle:

`new → enriched → qualified → contacted → engaged → meeting-booked → proposal/checkout → won/lost → nurture/reactivation`

### 4. Conversion Engine

All customer-facing journeys must provide one dominant next action:

- Purchase
- Book a call
- Apply
- Request wholesale information
- Join coaching
- Become an affiliate

Track funnel events from first touch through revenue. Do not optimize campaigns without source attribution and conversion data.

### 5. Customer Value Engine

After purchase:

- Confirm order and expectations
- Provide compliant education/onboarding
- Schedule appropriate follow-up
- Track customer satisfaction
- Request reviews and referrals after positive outcomes
- Identify relevant repeat-purchase, coaching, or partnership opportunities
- Respect the rule: do not send a duplicate email reply after the owner has manually responded

### 6. Revenue Intelligence Engine

Daily dashboard minimum:

- Revenue today, yesterday, last 7 days, month to date
- Orders and average order value
- New leads and qualified leads
- Leads contacted
- Responses
- Meetings booked
- Opportunities by stage
- Follow-ups overdue and due today
- Revenue by source
- Conversion rate by source
- Repeat-customer revenue
- Abandoned checkouts and recoveries
- B2B/wholesale pipeline value
- Coaching recurring revenue
- System health and data freshness

## Operating Roles

### Owner

Sets offers, risk tolerance, priorities, pricing, and final business decisions.

### ChatGPT — Revenue Strategy and Coordination

- Define offers, messaging, sales processes, KPIs, and bottleneck priorities
- Audit outputs against business outcomes
- Coordinate material findings and decisions with Claude through GitHub
- Separate intended behavior from verified production results

### Claude — Systems Engineering

- Build, deploy, monitor, test, and document the production systems
- Connect data sources to shared lead and revenue stores
- Expose usable reports and exports—not only internal databases
- Add monitoring and failure alerts
- Demonstrate production output before declaring completion

## Daily Operating Loop

1. Measure yesterday and current-day performance.
2. Identify the largest revenue bottleneck.
3. Assign one accountable owner and next action.
4. Execute sales activity before optional infrastructure work.
5. Verify output in production.
6. Record results, failures, and decisions.
7. Synchronize material updates through GitHub.

## Priority Engines

### Priority 0 — Existing Customer Revenue

Build the fastest path to cash from current and past customers:

- Clean customer list
- Segment by product, purchase date, and engagement
- Identify customers needing service follow-up
- Reactivation campaigns
- Referral requests
- Relevant repeat-purchase and coaching pathways
- Suppression of threads already manually handled

### Priority 1 — B2B Pipeline

Create a daily usable prospect list and follow-up workflow for:

- Med spas
- Wellness clinics
- Hormone/functional-health practices where compliant
- Gyms and trainers
- Beauty and skincare partners
- Qualified affiliates

A B2B lead counts only when it contains a real business identity and a valid email, phone, contact form, or verified social outreach path.

### Priority 2 — Storefront Conversion and Attribution

- Verify live storefront repository and deployment
- Implement source and campaign attribution
- Track product view, add-to-cart, checkout start, purchase, and repeat purchase
- Test the entire purchase flow in production
- Monitor failures

### Priority 3 — Bluesky Lead Pipeline Repair

The Bluesky system is currently considered broken until it delivers usable prospects to an owner-visible destination.

Required production contract:

1. Discover relevant prospects.
2. Store normalized records.
3. Enrich with available contact channels.
4. Deduplicate.
5. Score and rank.
6. Export daily into a visible Google Sheet/Doc or dashboard.
7. Show run timestamp, records scanned, leads created, qualified leads, errors, and next run.
8. Alert when a run creates zero qualified leads or becomes stale.

Raw social handles without a contact path do not satisfy the business requirement.

## 14-Day Revenue Sprint

### Days 1–2: Reality Audit

- Inventory every active revenue-related system
- Identify production URL/repository, owner, data store, last successful run, and verified output
- Mark each system `verified`, `degraded`, `broken`, or `unproven`
- Produce a single gap report

### Days 3–5: Lead Delivery

- Repair Bluesky pipeline or replace it with a dependable B2B lead source
- Deliver the first owner-visible list of qualified leads
- Create shared lead schema and deduplication
- Add daily freshness and zero-output alerts

### Days 6–8: Sales Workflow

- Create pipeline stages and daily follow-up queue
- Import existing customers and known prospects
- Add manual-response suppression for Gmail workflows
- Track outreach, response, meeting, and sale

### Days 9–11: Attribution

- Connect storefront events and completed purchases
- Record source/campaign for orders
- Add revenue-by-source reporting
- Verify production checkout and notifications

### Days 12–14: Executive Dashboard

- Publish a daily dashboard
- Add morning revenue report and bottleneck recommendation
- Document failures and ownership
- Remove or pause systems that do not produce measurable value

## Definition of Done for Phase One

Phase One is complete only when all of the following are verified:

- A visible lead destination exists and receives qualified leads
- At least one acquisition source produces usable leads on multiple consecutive runs
- Every lead has status, owner, and next action
- Existing customers are segmented for reactivation and follow-up
- Revenue is attributable to a source when possible
- A daily dashboard displays fresh revenue and pipeline metrics
- Failures trigger visible alerts
- Documentation identifies production systems, owners, and recovery steps

## Decision Filter

Before starting any work, ask:

> Does this directly create qualified demand, increase conversion, recover revenue, improve retention, improve customer lifetime value, or make one of those outcomes measurable and reliable?

If not, place it behind the revenue sprint backlog.