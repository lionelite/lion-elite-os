# Lion Elite OS — Automation Setup Instructions

Use this document when GitHub sends failure emails or when you need to connect OpenAI / Gmail automation.

## 1. What was fixed already

### Fixed: missing `data/orders/` folder
The `Order Inventory Sync` workflow failed because Git tried to add `data/orders/`, but the folder did not exist in the repository.

Error from GitHub Actions:

```text
fatal: pathspec 'data/orders/' did not match any files
Process completed with exit code 128.
```

Fix applied:

```text
data/orders/.gitkeep
```

That placeholder file keeps the folder alive in GitHub, so future workflows do not break just because the folder is empty.

### Fixed: repeated Daily Agent push failures
The `Daily Agent Automation` workflow was changed so it no longer runs on every push to `main`. It now runs by schedule or manual trigger only.

Current trigger behavior:

```yaml
on:
  schedule:
    - cron: '0 11 * * *'
  workflow_dispatch:
```

That means:

- It runs automatically once per day.
- It can be manually run from the GitHub Actions tab.
- It should not spam failure emails after every normal commit.

---

## 2. Important difference: ChatGPT login vs OpenAI API key

Your ChatGPT login is not the same thing as an OpenAI API key.

- ChatGPT login = lets you use the ChatGPT app or website.
- OpenAI API key = lets GitHub automation call OpenAI from a workflow.

The `Daily Agent Automation` workflow checks for this secret:

```text
OPENAI_API_KEY
```

If that secret is missing, the workflow should still create fallback content, but it will not generate true AI-powered output.

---

## 3. Add the OpenAI API key to GitHub

### Step A — Create the OpenAI API key

1. Log in to the OpenAI API platform.
2. Go to API keys.
3. Create a new API key.
4. Copy it one time.
5. Do not paste it into chat, email, GitHub files, screenshots, or public notes.

### Step B — Add it to GitHub as a secret

Repository:

```text
lionelite/lion-elite-os
```

Click path:

```text
GitHub → lionelite/lion-elite-os → Settings → Secrets and variables → Actions → Secrets → New repository secret
```

Create this secret:

```text
Name: OPENAI_API_KEY
Secret: paste the OpenAI API key value
```

Click:

```text
Add secret
```

---

## 4. Run the Daily Agent Automation manually

After adding `OPENAI_API_KEY`:

1. Open the repository.
2. Click `Actions`.
3. Click `Daily Agent Automation`.
4. Click `Run workflow`.
5. Fill in:

```text
brand: Lion Elite Beauty
topic: daily lead generation
task: Complete the highest-impact revenue task first.
```

6. Click `Run workflow`.

Expected result:

- It creates a new file inside `agent-outputs/YYYY-MM-DD/`.
- It updates `agent-outputs/LATEST_DAILY_AUTOMATION.md`.
- It commits the new output back into the repo.

---

## 5. Current Order Inventory Sync mode

The current `Order Inventory Sync` workflow is in safe no-password mode.

That means:

- It does not store Gmail passwords.
- It does not store Gmail app passwords.
- It does not currently read Gmail directly inside GitHub.
- It should finish successfully as a status check.

Current workflow message:

```text
Lion Elite OS order sync is in no-password mode.
No Gmail passwords, app passwords, OAuth secrets, or private email credentials are required in this workflow.
Order/inventory updates should be handled through connected ChatGPT Gmail access, manual inventory updates, or a future website webhook that does not require storing email passwords in GitHub.
```

---

## 6. If you later want full automatic Gmail order syncing

Only do this if you intentionally want GitHub Actions to read order emails directly.

Required GitHub secrets would be:

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

But this should be treated as a separate project because it requires Google Cloud OAuth setup, Gmail API access, correct scopes, token generation, and secure secret handling.

Better long-term option:

```text
Website checkout/order webhook → inventory update script → commit or database update
```

That avoids putting Gmail access into GitHub and is cleaner for business operations.

---

## 7. What to do when a GitHub failure email comes in

Follow this order:

1. Open the email.
2. Look for the workflow name.
3. Look for the failing job name.
4. Open the workflow run.
5. Open the failed job logs.
6. Find the first real error line, usually near the bottom.
7. Ignore warnings unless the job actually failed.
8. Fix the file/path/secret/code causing the first real error.
9. Re-run the failed job.
10. If it succeeds, no more action is needed.

Common examples:

| Error | Meaning | Fix |
|---|---|---|
| `pathspec did not match any files` | Git is trying to add a file/folder that does not exist | Create the file/folder or change the `git add` command |
| `OPENAI_API_KEY was not available` | GitHub does not have the OpenAI key secret | Add `OPENAI_API_KEY` under GitHub Actions secrets |
| `Google OAuth secrets missing` | Gmail sync secrets are not configured | Add Google OAuth secrets only if live Gmail sync is intentionally enabled |
| `No jobs were run` | Workflow trigger or path rules prevented a job from starting | Check the `on:` triggers and job conditions |
| `Permission denied` | GitHub token or workflow permissions are too limited | Check the workflow `permissions:` block |

---

## 8. Current operating rule

For Lion Elite OS:

1. Keep private credentials out of files.
2. Use GitHub repository secrets for API keys.
3. Use manual or scheduled workflows for agent output.
4. Use ChatGPT connected Gmail for email-based work unless a real webhook is built.
5. Use the website/webhook route for serious inventory automation.
