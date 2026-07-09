# Verify OpenAI Daily Agent Automation

This trigger should run `.github/workflows/daily-agent-automation.yml` after `OPENAI_API_KEY` was added to repository secrets.

Expected result:
- GitHub Actions runs Daily Agent Automation.
- The workflow writes `agent-outputs/LATEST_DAILY_AUTOMATION.md`.
- If the key is valid, output mode should be `openai-api`.
