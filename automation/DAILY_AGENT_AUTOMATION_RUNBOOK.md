# Daily Agent Automation Runbook

Status: NO PUSH
Last confirmed: 2026-07-09

## Purpose
Daily Agent Automation is the controlled AI execution workflow for Lion Elite OS.

It should create daily execution output for:
- Lion Elite Beauty
- Lion Elite Wellness
- AlexTheLionLifts
- Sales follow-up
- Website/funnel work
- Operations
- Money and growth

## Current Trigger Rules

Daily Agent Automation is allowed to run only by:

```yaml
schedule:
  - cron: '0 11 * * *'
workflow_dispatch:
```

It must NOT run on:

```yaml
push:
```

## Why No Push

The workflow used to throw red checks on normal commits because GitHub treated it as a push workflow even when no job was needed.

New rule:

- Render deploy runs automatically on push.
- Daily Agent Automation does not run on push.
- Daily Agent Automation runs manually or on the scheduled daily time.

## How Alex Runs It Manually

1. Go to GitHub.
2. Open `lionelite/lion-elite-os`.
3. Click **Actions**.
4. Click **Daily Agent Automation** in the left sidebar.
5. Click **Run workflow**.
6. Leave defaults or change:
   - Brand
   - Topic
   - Task
7. Click the green **Run workflow** button.

## Expected Output

The workflow should create or update:

```txt
agent-outputs/LATEST_DAILY_AUTOMATION.md
```

If OpenAI is connected correctly, the output should include:

```txt
Mode: openai-api
```

## Required GitHub Secret

```txt
OPENAI_API_KEY
```

This is already added.

## Do Not Add

Do not add email passwords or app passwords.

```txt
GMAIL_APP_PASSWORD
GMAIL_ADDRESS
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

## Automation Division

### Automatic on Push
- Trigger Render Deploy

### Manual or Scheduled Only
- Daily Agent Automation

### Assisted Through ChatGPT Connectors
- Gmail follow-up
- Calendar scheduling
- Calendly links
- Order checks
- Inventory updates

## If Red Daily Agent Checks Appear Again

Check `.github/workflows/daily-agent-automation.yml`.

The top should NOT contain:

```yaml
push:
```

If `push:` appears again, remove it.

## Current Rule

Daily Agent Automation = no push.
Render Deploy = push.
