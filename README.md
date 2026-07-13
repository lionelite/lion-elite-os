# Lion Elite OS

This repository is the operating system for Lion Elite Wellness, Lion Elite Beauty, BUNKER, real estate projects, sales systems, content, and internal operations.

## Top Priority — AI Lead Intelligence Engine

Build a continuous, autonomous lead generation, outreach, follow-up, and sales intelligence system using lawful, publicly available professional and business information.

The system now includes an executable outreach-validation and public business email-enrichment MVP.

The system must:

1. Discover qualified businesses continuously.
2. Verify, normalize, deduplicate, and organize public business information.
3. Build searchable business knowledge profiles with source attribution and freshness timestamps.
4. Use AI to understand each prospect’s business, likely goals, challenges, buying signals, and opportunities before outreach.
5. Score prospects using fit, intent, timing, data confidence, and relationship potential.
6. Equip human representatives with personalized research briefs, discovery questions, conversation guidance, objections, and recommended Lion Elite solutions.
7. Generate and send personalized outreach automatically when qualification, validation, suppression, consent, provider, and channel-specific requirements pass.
8. Keep the CRM current through outcome logging, ownership rules, lifecycle stages, follow-up tasks, and stale-record refreshes.
9. Learn from responses, meetings, conversions, retention, and losses to improve qualification and scoring.
10. Respect privacy, website terms, robots directives, applicable law, suppression lists, consent requirements, and channel-specific outreach rules.

### Executable services

Run the existing command center:

```bash
npm start
```

Run the outreach-validation and email-enrichment service:

```bash
npm run outreach
```

The outreach service can:

- Normalize and fingerprint business identities.
- Calculate explainable qualification scores.
- Enforce sixteen fail-closed pre-send checks.
- Inspect official business websites and same-domain contact pages for public business emails.
- Record the exact source URL, capture time, domain match, inbox type, and confidence.
- Process enrichment batches of up to 25 businesses.
- Generate an authorization and idempotency key only after all required validation checks pass.

It does not guess email addresses or use people-search data. When authorized delivery credentials are configured, validated messages can be dispatched automatically through the outreach worker.

Primary success metrics:

- Qualified leads created
- Verified-data rate
- Duplicate rate
- Positive response rate
- Meetings booked
- Lead-to-customer conversion rate
- Customer retention and expansion
- Time saved per representative
- Data freshness
- Automated delivery, reply, meeting-booking, and compliance success rates

Detailed specifications:

- [`ai-agents/lead-intelligence-engine.md`](ai-agents/lead-intelligence-engine.md)
- [`docs/outreach-validation-api.md`](docs/outreach-validation-api.md)

## Real Estate Intelligence MVP

The repository now includes an executable property acquisition scoring engine for multifamily, off-market, distressed, pre-foreclosure, and broker-sourced opportunities.

It provides:

- Explainable scoring for seller motivation, equity, economics, physical condition, legal risk, market quality, and data confidence.
- Deal-killer gates for illegal units, title defects, uninsurability, structural hazards, inspection denial, and suspected financial-document fraud.
- NOI, cap-rate, DSCR, all-in basis, and discount-to-value calculations.
- A due-diligence checklist assigning every verification task to the appropriate broker, attorney, inspector, contractor, lender, insurance broker, CPA, or property manager.
- A five-property comparison demo and automated tests.

Run it with:

```bash
node real-estate/intelligence/src/demo.js
node --test real-estate/intelligence/test/scoring.test.js
```

Documentation: [`real-estate/intelligence/README.md`](real-estate/intelligence/README.md)

## Mission

Build Lion Elite into a scalable business ecosystem with clear systems, repeatable processes, organized execution, and daily progress tracking.

## Core Brands

### Lion Elite Wellness
Research-focused peptide and wellness product operations.

### Lion Elite Beauty
Client programs, biomarker workflows, coaching resources, and optimization services.

### BUNKER
Premium gym and wellness ecosystem concept, investor materials, locations, and expansion planning.

### Real Estate
BRRRR, FHA, DSCR, distressed property acquisition, deal analysis, and funding structure.

### Sales System
Scripts, objections, follow-ups, client pipelines, and closing frameworks.

## Folder Map

| Folder | Purpose |
|---|---|
| `marketing/` | Instagram, TikTok, email, Meta ads, campaigns |
| `sales/` | Scripts, follow-ups, objections, closing systems |
| `lion-elite-wellness/` | Products, SOPs, labels, manufacturing, compliance language |
| `lion-elite-beauty/` | Programs, biomarker testing, client materials |
| `bunker/` | Investor deck assets, model, locations, branding |
| `real-estate/` | BRRRR, FHA, DSCR, deals, property analysis |
| `operations/` | Daily tasks, weekly reviews, KPIs, hiring, accountability |
| `templates/` | Reusable issue, SOP, campaign, and content templates |
| `ai-agents/` | Role prompts for marketing, sales, operations, research, finance, and lead intelligence |
| `lib/` | Executable validation and enrichment modules |
| `test/` | Automated safety and behavior tests |

## Daily Workflow

1. Add new ideas as GitHub Issues.
2. Prioritize the most valuable tasks.
3. Move active work into execution.
4. Use documents and SOPs to make work repeatable.
5. Review weekly KPIs and improve the system.

## How to Use ChatGPT With This Repo

Ask ChatGPT to:

- Create or update files.
- Draft SOPs.
- Build marketing campaigns.
- Create GitHub Issues.
- Review business workflows.
- Organize sales scripts.
- Turn scattered ideas into execution plans.
- Build templates for the team.

## Current Focus

- Deploy and test the AI Lead Intelligence Engine.
- Connect enrichment evidence to persistent prospect records.
- Add campaign configuration, suppression storage, and audit events.
- Build the authorized delivery worker and CRM synchronization.
- Build the Real Estate Intelligence data-ingestion and five-property comparison dashboard.
- Systemize Lion Elite Wellness operations.
- Build repeatable content and sales execution.
