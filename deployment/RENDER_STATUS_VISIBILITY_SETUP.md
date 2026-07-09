# Render Status Visibility Setup

GitHub can already trigger Render deploys through `RENDER_DEPLOY_HOOK_URL`.

To let GitHub also check Render deploy status after triggering a deploy, add these repository secrets:

## Required GitHub Secrets

### RENDER_API_KEY
Your Render API key.

### RENDER_SERVICE_ID
Your Render service ID.

Current Render service ID from the dashboard screenshot:

`srv-d97b8b6rnols73cl2hag`

## Where To Add Secrets

GitHub repo:

`lionelite/lion-elite-os`

Path:

Settings → Secrets and variables → Actions → New repository secret

## Current Workflow

File:

`.github/workflows/render-deploy.yml`

The workflow now does this:

1. Checks `RENDER_DEPLOY_HOOK_URL` exists.
2. Sends a POST request to the Render deploy hook.
3. If `RENDER_API_KEY` and `RENDER_SERVICE_ID` exist, it checks the latest Render deploy status through the Render API.
4. If those optional secrets are missing, it skips the status check without failing.

## Status

GitHub trigger is active.
Render status visibility is prepared.
Full Render status visibility requires adding the two optional secrets above.
