# Claude Code handoff — coaching PWA review

Use this handoff from an authenticated Claude Code session after checking out the feature branch or pull request.

## Scope

Review the new installable coaching portal at `/coaching/` and its `/api/coaching` API. Preserve the existing command center, outreach services, Render topology, branch protection, and hard limits in `CLAUDE.md`.

Start with:

```bash
npm install
node --test test/coaching-portal.test.js
npm test
npm run validate:render
node scripts/smoke-check.js
```

Then run the portal locally with an ephemeral token:

```bash
export COACH_PORTAL_ADMIN_TOKEN='local-review-only-not-for-production'
COACHING_DEMO_MODE=true npm run dev
```

## Review priorities

1. Verify coach and client authorization on every endpoint, one-time invitation redemption, session expiration, origin checks, cookie flags, and client-record isolation.
2. Verify the service worker never caches `/api/*`, authenticated data, invitations, or session material.
3. Walk the full mobile flow: coach login → create client → add at least three video exercises → create/publish workout → create/publish care plans → copy invite → client redemption → play/open each exercise demo → log workout → exchange messages → submit check-in → install instructions.
4. Confirm workout assistance can use only approved video-library exercises and cannot create supplement, diet, peptide, rehabilitation, diagnosis, or other medical instructions.
5. Confirm a peptide protocol remains display-only and cannot be published without a named licensed clinician plus `clinicianConfirmed=true` at both API and database layers.
6. Check responsive layout, keyboard navigation, labels, focus, contrast, empty states, error states, and iOS/Android install guidance.
7. Report concrete findings by severity. Fix verified defects on a branch, but do not weaken auth, medical guardrails, tests, branch protection, or deployment controls.

## Acceptance result

The review is complete only when the focused test, full suite, Render validation, smoke check, and an actual mobile browser walkthrough pass. State separately anything that could not be verified, especially production Render variables, push credentials, live-domain installation, and notification delivery.
