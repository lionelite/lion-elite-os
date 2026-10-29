# Base44 ↔ Claude Code Bridge

## Goal
Make Base44 application source code available in GitHub so Claude Code can review, refactor, test, document, and improve it alongside Lion Elite OS.

## Connected Base44 apps
Verified against the Base44 API on 2026-10-20 (`list_user_apps`). The workspace is
`6a85aed0dc102f8ed2cd94eb`.

| App | App ID | Notes |
|---|---|---|
| **Base 44 Studio** | `6abf2f9a1efb94c996802962` | **This is BuildPipeline.** The name is misleading — it holds `buildpipeline.online` and the BuildPipeline data model. |
| Base44 Builder | `6ac835404f5a17b5073f0649` | No custom domain. |
| LionEliteBeauty | `6a96da19bdddc166b7ea1b82` | This ID was previously recorded here as "ProfitFlow". There is no app named ProfitFlow in the workspace; the ID resolves to LionEliteBeauty. |
| ZenFlow | `6a85c66afdcf541c21211c65` | — |

## buildpipeline.online

Attached to **Base 44 Studio**, not to Render and not to Vercel. Added 2026-10-09 by
info@lionelitewellness.com. Base44 reports it `verified`, propagated, and not disabled:

- `A buildpipeline.online -> 216.24.57.1`
- `CNAME www -> base44.onrender.com`
- published slug URL: `https://strict-base-build-core.base44.app`

This matters for a mistake that was nearly made twice: **do not point this domain at
Render.** `render.yaml` in the business-system repo carries a `buildpipeline` web
service that has never been applied, and attaching the apex there would fight the
Base44 record that already serves it. Decide the host first, move the domain second.

The dev sandbox proxy returns 403 for both `buildpipeline.online` and
`*.base44.app`, so a live fetch cannot be used to confirm the page from here. Verify
through the Base44 API (domain status, `is_unpublished`, `public_settings`) or from a
real browser.

## BuildPipeline data model as it stands (2026-10-20)

13 entities, holding real production data — any restructure must migrate, not recreate:

- `ClinicLead` — 35 records (31 `production`, 4 `demo`); **20 are `contacted`** with real
  business e-mail addresses. This is the live prospect table.
- `MiamiInPersonClinic` — 6 records with named owners (field-sales targets).
- `FieldVisitTarget` — overlaps `MiamiInPersonClinic` for the same purpose.
- `Campaign`, `Client`, `CRMContact`, `CRMTask`, `ClinicDeal`, `Meeting`,
  `OutreachActivity`, `SyncEvent`, `Lead`, `User`.

Gaps against the product spec: not multi-tenant (no `Workspace`; `Campaign.workspace`
is the hard-coded string `lion_elite_clinical`); two overlapping clinic tables; no
agent, audit, research, sequence or revenue-attribution entities; stage enums do not
match the canonical lifecycle.

## Access: what works and what does not

| Capability | State |
|---|---|
| Platform API (`list_api_catalog`, `execute_api`) | Works. |
| Entity schemas and records (`list_entity_schemas`, `query_entities`) | Works — this is how the data above was read. |
| Direct file access (`read_file`, `write_file`, `edit_file`, `grep`, `run_command`) | **Blocked.** Base44 returns: "External coding agents require the Builder plan or above." Upgrading is owner spend. |
| Builder AI turns (`edit_base44_app`) | Available on the free tier, but **currently denied by the Claude Code permission classifier**. Needs a permission rule for `mcp__Base44__edit_base44_app`. |

So with the plan as-is the only way to change the app is a builder turn, and that needs
the owner to allow the tool. Reading and inspecting need neither.

## Once sandbox/file access is enabled
1. Read the Base44 app directory recursively.
2. Mirror source into a dedicated GitHub repository or `base44-apps/<app-name>/` subtree.
3. Preserve Base44-specific config and generated files.
4. Add `.env.example` only; never commit secrets.
5. Add build/test scripts and a code map.
6. Claude Code should treat GitHub as the collaboration surface and Base44 as the live application builder/runtime unless deliberately migrated.
7. Any changes intended for Base44 must be synchronized back to the Base44 app and checkpointed.

## Claude Code working rules
- Never invent Base44 files that were not exported/read from the sandbox.
- Inspect the full app structure before refactoring.
- Preserve data entity schemas and authentication behavior.
- Keep user-facing behavior stable unless the requested change explicitly alters it.
- Run tests/build checks before proposing merge.
- Document any Base44-specific dependency or integration before changing it.
- Direct edits are committed but not checkpointed — call `create_checkpoint` when
  finishing a set of edits, or a Restore in the builder discards them.
- One turn at a time: do not edit files while the app status is `processing`.

## Sync target
Primary coordination repository: `lionelite/lion-elite-os`.

## Status
`BUILDER_TURNS_BLOCKED_BY_PERMISSION_RULE` — file access still needs the Builder plan;
builder turns need `mcp__Base44__edit_base44_app` allowed in Claude Code settings.
