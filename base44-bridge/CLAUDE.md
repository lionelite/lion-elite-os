# Base44 ↔ Claude Code Bridge

## Goal
Make Base44 application source code available in GitHub so Claude Code can review, refactor, test, document, and improve it alongside Lion Elite OS.

## Connected Base44 apps
- ProfitFlow — app id `6a96da19bdddc166b7ea1b82`
- ZenFlow — app id `6a85c66afdcf541c21211c65`

## Current blocker
Base44 direct sandbox/file access for external coding agents is currently blocked by the Base44 workspace plan. Base44 reports that sandbox-bridge tools require the Builder plan or above. The apps currently use Base44-managed S3 source rather than a GitHub remote.

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

## Sync target
Primary coordination repository: `lionelite/lion-elite-os`.

## Status
`WAITING_FOR_BASE44_BUILDER_SANDBOX_ACCESS`
