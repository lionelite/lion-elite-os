# Lion Elite Coaching PWA

## What is built

`/coaching/` is a mobile-first Progressive Web App served by the existing `lion-elite-os` Express service. It uses the same practical information architecture clients expect from a modern coaching portal—today, training, plan, messages, and progress—without copying another product's branding or code.

Coach capabilities:

- Create and manage private client profiles.
- Issue a one-time, seven-day app link. The secret stays in the URL fragment so it is not sent to web servers or referrers.
- Maintain a coach-approved exercise library using HTTPS, YouTube, Vimeo, or direct video links.
- Generate a rule-based workout draft with no AI key, or an OpenAI-assisted draft when `OPENAI_API_KEY` is configured.
- Review and publish video-backed training plans.
- Publish nutrition and supplement plans.
- Store a peptide protocol only as a display record of instructions already confirmed by a named licensed clinician.
- Exchange live messages, receive client check-ins, and review logged workouts.

Client capabilities:

- Redeem the private link once, then use a hashed, 30-day server session in an HttpOnly, SameSite cookie.
- Install the PWA from the link without an App Store.
- See today's assignment, open an exercise demo for every movement, record sets, and log the workout.
- See only the current published nutrition, supplement, and clinician-confirmed protocol plans.
- Message the coach in real time and optionally enable privacy-safe Web Push alerts.
- Submit weight, sleep, energy, adherence, soreness, and written check-ins.

## Local run

The fastest UI/API check uses the explicit in-memory demo store:

```bash
npm install
export COACH_PORTAL_ADMIN_TOKEN='local-development-only-not-for-production'
COACHING_DEMO_MODE=true npm run dev
```

Open `http://localhost:3000/coaching/` and use `local-development-only-not-for-production` at the coach sign-in. Demo data is intentionally erased when the process restarts.

For the real Postgres-backed mode:

```bash
export DATABASE_URL='postgresql://...'
export COACH_PORTAL_ADMIN_TOKEN="$(openssl rand -hex 32)"
npm run db:migrate
npm start
```

Never set `COACHING_DEMO_MODE=true` in production.

## Production configuration

| Variable | Required | Purpose |
|---|---:|---|
| `DATABASE_URL` | Yes | Existing Render Postgres connection; migrations create the isolated `coaching_*` tables. |
| `COACH_PORTAL_ADMIN_TOKEN` | Yes | Long random coach sign-in secret. `render.yaml` requests a generated value for the main web service. |
| `COACHING_PUBLIC_URL` | Recommended | Canonical HTTPS origin used to construct invite links, such as `https://app.example.com`. |
| `OPENAI_API_KEY` | No | Enables AI-assisted workout drafts. Without it, the safe deterministic planner remains fully functional. |
| `OPENAI_MODEL` | No | Defaults to `gpt-4.1-mini`. |
| `WEB_PUSH_PUBLIC_KEY` | No | Public half of the VAPID key pair used for message alerts. |
| `WEB_PUSH_PRIVATE_KEY` | No | Secret VAPID private key. Store only in Render's environment settings. |
| `WEB_PUSH_SUBJECT` | No | VAPID contact URI, normally a `mailto:` address. |

Generate a matching VAPID pair locally, then place each value in the service environment:

```bash
npx web-push generate-vapid-keys
```

Without the VAPID variables, live in-app messaging still works; background phone notifications remain disabled and the UI says so clearly.

## Coach launch workflow

1. Open `/coaching/` and sign in with `COACH_PORTAL_ADMIN_TOKEN`.
2. Add at least three exercises to **Video Library**. Use videos Lion Elite owns or has permission to display.
3. Create a client and copy the generated private app link.
4. Create the workout draft, inspect it, and publish it when correct.
5. Add nutrition or supplement guidance as needed.
6. Add a peptide protocol only when copying instructions from the named licensed clinician and check the confirmation box.
7. Send the app link through the normal trusted client channel.

The invite link is one-time use and expires after seven days. Generate a new link when needed; never place one in a public post or shared document.

## Phone installation

On iPhone or iPad:

1. Open the private link in Safari and redeem it.
2. Tap **Share**.
3. Choose **Add to Home Screen**, then **Add**.
4. Launch Lion Elite from the new icon. Enable alerts from Profile after the PWA is installed if Web Push is configured.

On Android, open the link in Chrome and choose **Install app** or **Add to Home screen**. Browsers that support the install prompt also expose an install button in the portal.

## Safety and privacy decisions

- Invitation and session secrets are stored only as SHA-256 hashes; invitation secrets are one-time and never placed in HTTP query strings.
- Session cookies are HttpOnly, SameSite=Strict, Secure in production, and scoped to `/api/coaching`.
- Mutating requests reject cross-site origins, API responses are non-cacheable, login/message routes are rate limited, and client queries are scoped to the authenticated client.
- The service worker caches only the public application shell, never authenticated API responses or client data.
- Push notifications deliberately omit message text and health details from lock screens.
- Workout generation can select only approved library exercises with videos. Publishing is a separate coach action.
- The assistant is prohibited from producing dosing, peptide, supplement, diet, diagnosis, or rehabilitation instructions.
- The database and API both prevent publication of a peptide protocol unless the coach records licensed-clinician confirmation. The portal is not an EHR, prescribing system, or emergency channel.

Before using the portal for regulated health information, obtain counsel on the organization's privacy, consent, retention, access-control, breach-response, and vendor-contract obligations. The shared coach token is suitable for this first controlled release; replace it with individual staff identity and MFA before multiple coaches need access.

## Verification

```bash
node --test test/coaching-portal.test.js
npm test
npm run validate:render
node scripts/smoke-check.js
```

The focused integration test covers coach authentication, client creation, one-time invite redemption, approved video exercises, draft and publish, role isolation, workout logging, messaging, clinician confirmation, PWA metadata, and service-worker cache boundaries.

## Key files

- `routes/coaching.js` — authenticated API and authorization boundaries.
- `lib/coaching/store.js` — Postgres implementation plus explicit test/demo store.
- `lib/coaching/workout-planner.js` — safe workout drafting and AI fallback.
- `lib/coaching/push.js` — optional Web Push delivery.
- `public/coaching/` — installable client and coach interface.
- `db/schema.sql` — durable coaching records and audit trail.
- `test/coaching-portal.test.js` — end-to-end API and PWA contract.
