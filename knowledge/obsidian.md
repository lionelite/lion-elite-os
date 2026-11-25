---
type: guide
tags: [guide]
---
# How this vault works

The whole `lion-elite-os` repo is an Obsidian vault. Open the repo folder in Obsidian and you'll see every doc, linked together through [[knowledge/Home|Home]] and the maps in `knowledge/maps/`. GitHub is still the system of record. Obsidian is just a better way to read, navigate and write the same markdown files.

## Rules
1. **The repo is public.** Business operating knowledge only. Never customer records, health data, passwords, API keys, account numbers, financials or private personal notes.
2. **Every kept note is linked from a map.** A note nothing points to is a note nobody finds. When you add a doc, add a line to the right map.
3. **Code stays code.** Code folders (`lib/`, `workers/`, `scripts/`…) are excluded from search and the graph. Settings live in `.obsidian/app.json`.
4. **Links use full paths**, like `[[docs/automated-outreach|Automated outreach]]`, because the repo has many files named `README`. Obsidian keeps links updated when you move or rename a file inside the app.
5. `test/obsidian-vault.test.js` checks that every link on the Home page and the maps points at a real file. A broken map fails CI.

## Folders
| Folder | What goes there |
|---|---|
| `knowledge/Home.md` | Start page |
| `knowledge/maps/` | One map per business and per function |
| `knowledge/inbox/` | Where new notes land; file them later |
| `knowledge/daily/` | Daily notes (Daily Note template) |
| `knowledge/decisions/` | One note per owner decision |
| `knowledge/_templates/` | Daily Note, Decision, Meeting, Campaign, Project |
| `knowledge/attachments/` | Images pasted into notes |

## Sync with GitHub (free)
`main` is branch-protected: every change needs the `test` check, so Obsidian can't push to it directly. The vault syncs to its own unprotected branch, **`vault`**, instead.

**Desktop (Mac / PC):**
1. Install Obsidian and Git.
2. `git clone https://github.com/lionelite/lion-elite-os` and then `git checkout vault`.
3. In Obsidian, choose *Open folder as vault* and pick the clone.
4. When asked, turn on community plugins, then install **Git** (by Vinzent, `obsidian-git`). Its settings are already committed: it pulls on startup, auto-commits every 10 minutes, and rebases before pushing.

**Phone:** the same Git plugin works in Obsidian mobile. Clone `lion-elite-os` from the plugin's *Clone* command, use a GitHub fine-grained token with *Contents: read/write* on this repo only, and switch to the `vault` branch. Mobile git is slower than desktop, which is fine for reading and quick capture.

**Getting notes onto `main`:** ask Claude to "merge the vault branch". Claude opens a `vault → main` pull request, CI runs, and you merge it. Claude can also merge `main` back into `vault` so the vault picks up new docs.

## For Claude and other agents
- New durable docs go in their usual folder and get a line on the matching map.
- Read [[knowledge/Home|Home]] first to find things. Then follow the lookup order in [[knowledge/execution-rules|execution rules]].
