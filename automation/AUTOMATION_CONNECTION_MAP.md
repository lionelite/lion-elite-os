# Lion Elite OS Automation Connection Map

Status owner: Alexander Ringfield / Lion Elite Wellness
Repo: `lionelite/lion-elite-os`
Rule: use official connectors, OAuth, webhooks, and deploy hooks. Do not store personal passwords in GitHub.

## Current Connected Foundation

### 1. GitHub to Render Deploy
Status: connected
Secret needed: `RENDER_DEPLOY_HOOK_URL`
Current status: added in GitHub repository secrets.
Purpose: every approved push to `main` can trigger Render deployment.
Next step: verify latest GitHub Actions deploy run turns green and Render shows a fresh deploy event.

### 2. GitHub Task System
Status: connected
Purpose: create issues, implementation tasks, workflow files, documentation, and operating system files for Lion Elite OS.
Next step: continue turning business needs into GitHub issues and build tasks.

### 3. Daily Agent Automation
Status: active, no-password mode
Purpose: generate a daily execution file under `agent-outputs/`.
Current status: workflow stabilized to stop failures.
Next step: add optional AI execution once `OPENAI_API_KEY` is added.

## Secrets That Are Safe to Add

### `RENDER_DEPLOY_HOOK_URL`
Purpose: triggers Render deploys from GitHub.
Type: deploy hook URL, not a password.
Status: added.

### `OPENAI_API_KEY`
Purpose: allows GitHub Actions to generate AI content and agent outputs automatically.
Type: API key.
Required only if GitHub should run AI without ChatGPT being open.

### `ORDER_WEBHOOK_SECRET`
Purpose: future website order webhook verification.
Type: random webhook signing code.
Required only after website webhook endpoint exists.

## Secrets We Are Not Using

Do not add these unless the security model changes:

- `GMAIL_APP_PASSWORD`
- `GMAIL_ADDRESS`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`

Reason: Alex does not want passwords or email credentials stored in GitHub.

## Automation Targets

### A. Orders to Inventory
Goal: when an order happens, inventory updates automatically.
Preferred method: website webhook.
No-password method: website sends order payload to a secure endpoint in Lion Elite OS.
Needed:
- Build `/api/orders/webhook` endpoint.
- Add `ORDER_WEBHOOK_SECRET` after endpoint exists.
- Connect order platform to the webhook.
- Update `public/data/current-inventory.json` and `data/inventory/current-inventory.json`.

Temporary method:
- Use ChatGPT Gmail connector to check order emails.
- Use GitHub connector to update inventory files.
- No passwords stored in GitHub.

### B. Inventory Source of Truth
Goal: one reliable inventory record.
Current file:
- `public/data/current-inventory.json`
- `data/inventory/current-inventory.json`

Current source note: Google Drive Sheet is treated as source of truth.
Next step:
- Build an admin inventory screen.
- Add manual adjustment history.
- Build low-stock alerts.

### C. Content Automation
Goal: daily content for Lion Elite Wellness, Lion Elite Beauty, and AlexTheLionLifts.
Safe connection:
- `OPENAI_API_KEY` for GitHub-native generation.
- ChatGPT automation for daily content direction.
Brand rules:
- Lion Elite Wellness = research-only education.
- Lion Elite Beauty = coaching, transformation, high-ticket sales, affiliates.
- AlexTheLionLifts = personal authority, lifting, discipline, faith, business.

### D. Gmail Follow-Up Automation
Goal: summarize leads, order replies, and follow-ups.
No-password method:
- Use ChatGPT Gmail connector during assisted workflows.
Future no-password method:
- Google OAuth app with restricted scopes and proper consent.
Do not use app passwords.

### E. Calendar and Calendly Automation
Goal: client scheduling, account setup calls, and follow-up reminders.
Current direction:
- Calendly connected through official connector.
- Google Calendar can be used through official connector.
Next step:
- Create standard meeting templates.
- Create follow-up email templates after each call.

### F. Website and Funnel Automation
Goal: connect website leads, product pages, coaching funnels, and order events.
Needed:
- Lead capture endpoint.
- Order webhook endpoint.
- CRM-style lead status file or database.
- Funnel copy files by brand.

### G. Sales Follow-Up Automation
Goal: every client conversation turns into a follow-up task and message.
Needed:
- Lead tracker.
- Call recap template.
- Follow-up sequence by offer.
- Calendar reminder or GitHub issue creation.

### H. Meta / Ads Automation
Goal: track ad ideas, campaign assets, hooks, and offers.
No-password method:
- Use official Ads Manager connector if available.
Next step:
- Build campaign asset library.
- Build weekly ad-testing board.

## Build Priority

1. Keep Render deploy secret working.
2. Add `OPENAI_API_KEY` only if GitHub should run AI automatically.
3. Build no-password order webhook endpoint.
4. Build inventory admin and low-stock alerts.
5. Build lead tracker and call recap workflow.
6. Build Agent Command Center dashboard.
7. Build daily content queue.

## Operating Rule

If automation requires a password, stop and find a webhook, OAuth, API key, or official connector alternative.
