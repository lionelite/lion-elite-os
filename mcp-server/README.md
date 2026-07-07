# Lion Elite Business MCP Server

This folder contains the scaffold for a custom MCP server that can connect ChatGPT to Lion Elite business data sources.

## Goal
Create one secure server URL that can be added inside ChatGPT Custom Tools so ChatGPT can review business performance and support daily execution.

## Initial Data Sources

Planned integrations:

- Meta Ads / Meta Marketing API
- Meta organic social insights where available
- Google Analytics 4
- Google Search Console
- Orchid website analytics, if API/export is available
- CRM data
- GitHub project progress
- Google Drive knowledge/assets, when supported separately

## Important Security Rule
Never commit real API tokens, ad account IDs, app secrets, OAuth secrets, client secrets, or customer data into GitHub.

Use environment variables only.

## Minimum Viable Version
The first useful version should expose read-only tools:

- `get_meta_ads_summary`
- `get_ga4_summary`
- `get_search_console_summary`
- `get_crm_pipeline_summary`
- `get_github_priority_tasks`
- `get_daily_executive_brief`

## Deployment Options
You can deploy this server on:

- Render
- Railway
- Fly.io
- Vercel with adaptation
- Cloudflare Workers with adaptation
- A private VPS

## ChatGPT Custom Tool Setup
After deployment, paste the public MCP server URL into ChatGPT's Custom Tool screen.

Example:

```text
https://your-lion-elite-mcp-server.com/sse
```

Do not paste Meta Graph API URLs directly. ChatGPT needs an MCP-compatible server endpoint, not a raw SaaS API.

## Current Status
This is a scaffold. It needs API credentials and deployment before it can connect live data.
