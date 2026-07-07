# Deployment Guide

## Current Status
The repository contains a starter Lion Elite Business data server scaffold.

This is not live yet. To use it in ChatGPT Custom Tools, it must be deployed to a public HTTPS URL.

## Recommended Deployment: Render

1. Create a Render account.
2. Create a new Web Service.
3. Connect GitHub.
4. Select the `lionelite/lion-elite-os` repository.
5. Set the root directory to `mcp-server`.
6. Build command: `npm install && npm run build`
7. Start command: `npm start`
8. Add environment variables inside Render.
9. Deploy.
10. Copy the public Render URL.

## Test URLs

After deployment, test:

- `/health`
- `/tools`

## Custom Tool Note
If ChatGPT requires a true MCP SSE endpoint, this scaffold must be upgraded from simple HTTP endpoints to the official MCP SSE transport.

## Data Setup Needed
To make the Meta summary work, you need:

- Meta Developer App
- Marketing API access
- Ad account access
- Access token
- Ad account ID

## First Integration Priority
Complete the Meta Ads summary first because paid and organic marketing performance directly supports the $100k/month roadmap.
