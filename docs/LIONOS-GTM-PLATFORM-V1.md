# LionOS GTM Platform v1

## Product thesis

Build a sellable, multi-tenant AI go-to-market operating system inspired by the strongest parts of TryGTM, while going beyond a fixed outbound agent roster.

The platform should let a business describe what it sells, define its target market, connect approved data and communication channels, and deploy a coordinated AI workforce that continuously finds opportunities, qualifies them, drafts or sends approved outreach, handles replies, books meetings, updates CRM records, measures revenue, and improves from outcomes.

## Core differentiation

Instead of a fixed five-agent roster, LionOS uses a configurable workforce. A workspace can start with a default revenue team, then add or disable specialist agents:
- Market Research
- ICP / Segmentation
- Lead Discovery
- Enrichment
- Intent
- Qualification
- Copy
- Outreach
- Reply Handling
- Appointment Booking
- CRM
- Revenue Analytics
- Retention / Reactivation
- Content
- Operations
- QA / Compliance
- Executive Orchestrator
- Developer / Automation

Agents share memory, tasks, evidence, outcomes, and accountability through one workspace.

## Customer promise

One platform that turns company + offer + ICP + connected channels into qualified conversations + booked meetings + measurable pipeline.

## v1 user journey

1. Create workspace.
2. Enter website or company description.
3. AI produces company profile, offer map, ICP suggestions, exclusion rules, keywords, and messaging angles.
4. User approves or edits.
5. Connect Gmail/Workspace, calendar, CRM, approved lead-data provider, webhooks/API, and optional permitted social workflows.
6. Create a campaign from plain English.
7. Platform finds/imports prospects.
8. Evidence-backed qualification scores each prospect.
9. Qualified prospects enter an action queue.
10. Copy agent drafts from source evidence.
11. QA/policy agent validates.
12. Campaign runs in supervised or autopilot mode.
13. Replies stop sequences and enter the unified inbox.
14. Reply agent classifies intent and drafts or executes the permitted next action.
15. Meeting agent schedules or hands off booking.
16. CRM and revenue records update automatically.
17. Insights show what generated pipeline and revenue.
18. Agents improve targeting, copy, sequencing, and priorities within workspace policy.

## Main product surfaces

### Command Center
- revenue and pipeline KPIs
- active campaigns
- qualified leads
- replies awaiting action
- meetings booked
- autonomous actions
- blocked actions / policy failures
- agent status
- system health

### AI Workforce
Each agent has role, objective, tools, permissions, schedule, model, KPIs, current task, activity log, context, delegation rules, and a pause switch.

### Campaign Builder
Plain-English campaign creation converted into ICP, filters, exclusions, triggers, offer, value proposition, sequence, channel mix, send windows, stop conditions, success event, and attribution rules.

### Prospect Intelligence
Every company/contact stores identity, source evidence, fit, intent, timing, reachability, confidence, current tools, likely pain, opportunity hypothesis, relationship history, owner, next action, lifecycle, and audit history.

### Unified Inbox
Reply classification, objection, opt-out, interest level, drafted response, recommended action, meeting suggestion, human takeover, and autonomous-action log.

### Meetings
Calendar integration, availability, scheduling, reminders, prep brief, notes, and next steps.

### CRM / Pipeline
Lifecycle: discovered -> qualified -> contacted -> replied -> meeting -> opportunity -> won/lost -> retained/reactivation.

### Insights
Market size, leads sourced, qualified rate, reply rate, positive reply rate, meetings, opportunities, revenue, source performance, campaign performance, message performance, agent performance, funnel leakage, and freshness.

### Integrations
Initial targets: GitHub, Claude/MCP, OpenAI, Gmail, Google Calendar, Calendly, Slack, webhooks, CRM adapters, and approved lead-data providers.

## Multi-tenant architecture

All core business records require workspace_id. Core entities include workspaces, users, memberships, agents, agent_runs, agent_tasks, companies, contacts, evidence, icps, campaigns, campaign_steps, qualification_scores, messages, sends, inbox_threads, inbox_messages, meetings, opportunities, integrations, audit_events, usage_ledger, and subscriptions.

Every query and action must be workspace-scoped.

## Orchestration model

Use an event-driven state machine. Important events include workspace.created, company_profile.approved, prospect.discovered, prospect.enriched, prospect.qualified, signal.detected, outreach.queued, outreach.validated, outreach.sent, reply.received, reply.classified, meeting.requested, meeting.booked, opportunity.created, opportunity.won, opportunity.lost, customer.inactive, and integration.failed.

The Executive Orchestrator assigns work instead of doing every task itself.

## Agent accountability

Agents are peers in one operating system, not isolated chatbots. Every task records objective, assigned agent, delegated-by, schedule/deadline, required evidence, output, validation, KPI affected, success/failure, and follow-up.

QA agents can block actions. No agent can silently override another agent's hard policy constraint.

## GitHub + Claude

GitHub is the product-development source of truth. Claude Code should use the existing claude-automation workflow, build from current main, keep changes small and testable, post progress to Issue #38, never bypass CI, and prefer production-visible output over scaffolding.

Add MCP/API methods so permitted AI clients can inspect workspace state, create/update campaigns, inspect agents, enqueue tasks, retrieve insights, read activity, pause campaigns, and manage approved configuration.

## MVP scope

Ship authentication + workspaces, onboarding, company/offer/ICP profile, agent roster, campaign builder, prospect records, CSV import, current public-site email enrichment, qualification, evidence-backed message generation, validation gate, guarded email sending, unified reply inbox, calendar handoff, built-in CRM, basic insights, usage ledger, Stripe-ready subscription structure, and GitHub/Claude developer integration.

## Delivery sequence

### Phase 0 - Product shell
- SaaS navigation and design system
- authentication
- workspace model
- tenant isolation
- onboarding
- Command Center

### Phase 1 - Revenue engine
- campaigns
- ICP
- prospects
- scoring
- evidence
- email
- replies
- calendar
- CRM
- insights

### Phase 2 - AI workforce
- agent registry
- activity
- schedules
- shared tasks
- delegation
- configurable prompts
- model selection
- permissions
- KPIs

### Phase 3 - Data + channels
- commercial lead-data integration
- enrichment providers
- Gmail
- Calendly
- CRM adapters
- Slack
- webhook/API
- compliant channel expansion

### Phase 4 - Agency mode
- multiple client workspaces
- white label
- client roles
- reporting
- template cloning

### Phase 5 - Platform
- public API
- MCP
- agent templates/marketplace
- custom workflows
- custom agents
- billing and metering
- partner ecosystem

## Immediate build priorities

1. Introduce workspace tenancy without breaking current Lion Elite internal usage.
2. Create SaaS shell and /app navigation.
3. Add onboarding that converts website/company description into an editable GTM profile.
4. Add Campaigns, Prospects, Inbox, CRM, Agents, Insights, and Integrations pages.
5. Refactor current prospect/outreach code behind workspace-aware services.
6. Create agent registry and event/task schema.
7. Connect existing guarded email pipeline to campaign records.
8. Add reply ingestion architecture and calendar handoff.
9. Add usage ledger for future billing.
10. Expose safe MCP/API methods for Claude.

## v1 acceptance criteria

A brand-new workspace can onboard a company, define ICP and offer, create a campaign, import/discover prospects, qualify them with visible evidence, draft a personalized email, pass validation, send through an explicitly authorized email channel, ingest a reply, stop the sequence, classify the reply, create a next action, book or hand off a meeting, update CRM stage, show campaign funnel metrics, and show every autonomous action in an audit trail.

No cross-workspace data access is possible.

## Commercial model target

Design billing around platform subscription, included usage credits, metered data/enrichment, metered AI/action usage, and optional agency/client workspaces. Do not hard-code pricing into architecture.

## Product principle

The interface should hide complexity. A customer should be able to say: Here is what I sell. Find the right people and create conversations. The platform translates that intent into a governed, inspectable, continuously improving GTM operation.