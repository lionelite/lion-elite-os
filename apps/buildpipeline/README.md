# BuildPipeline VSL Funnel

Next.js App Router front end for BuildPipeline's video-sales-letter funnel.
Funnel config, analytics and CRM writes live in Lion Elite OS
(`routes/gtm-funnels.js`, `lib/platform/vsl-funnel.js`, `lib/platform/funnel-store.js`).
This app holds no data of its own.

## Funnel stages
Traffic → VSL → Application → Booking → Confirmation → Follow-up

| Stage | Evidenced by | Where it lands |
|---|---|---|
| Traffic | `page_view` | `gtm_funnel_events` (UTM + referrer host only) |
| VSL | `cta_revealed`, `video_play` (hosted files only) | `gtm_funnel_events` |
| Application | `cta_click`, `lead_qualified` | lead → `gtm_prospects` (`qualified`) + answers → `gtm_evidence` + SMS consent record → `gtm_funnel_leads` |
| Booking | `booking_click` | `gtm_meetings` (`proposed`): a click is **not** a booking |
| Confirmation | `booking_confirmed` (Calendly webhook or operator) | `gtm_meetings` (`booked`), prospect `meeting`, `gtm_opportunities` `meeting` |
| Follow-up | `follow_up_planned` | `gtm_agent_tasks`, all `draft_only`; SMS steps only with consent |

## What was replaced (the README's original integration targets)
- **`demoFunnel` → funnel config model.** `GET /api/gtm-funnels/public/:slug` serves
  published funnels from `gtm_funnels`. Unknown slugs 404 instead of rendering the
  demo for any URL. `/funnel/demo` still works locally when no backend is set, and
  says on the page that nothing is stored.
- **`console.log` → persistence.** `/api/funnel-events` and `/api/funnel-leads`
  forward to the backend server-side. Without a backend they answer
  `{persisted: false}` instead of the old `{ok: true}`.
- **Generic booking URL → connected calendar.** A funnel can't be published
  without a specific scheduling page (`https://calendly.com/` is refused). The link
  carries `utm_content=<session>` so a Calendly `invitee.created` webhook can
  confirm the exact booking.
- **CRM + follow-up hooks.** See the table above. The app never sends a message.
  Follow-up is queued as draft agent tasks behind the workspace sender policy.

## Deliberate behaviour changes from the prototype
- Lead identity (name/email/phone/answers) is no longer posted inside an analytics
  event. It goes to the CRM only.
- The final screen no longer claims "✓ Funnel conversion recorded" after a calendar
  click. Confirmation comes from the calendar.
- YouTube/Vimeo/Wistia URLs now embed. The old `<video>` tag could not play them.
  Embeds do not report `video_play`, because an iframe load is not a play.
- SMS consent is an optional, unticked checkbox with the consent wording stored
  alongside the lead (TCPA prior express written consent).

## Environment
| Variable | Where | Purpose |
|---|---|---|
| `BUILDPIPELINE_API_URL` | this app | Lion Elite OS origin. Unset = demo mode. |
| `BUILDPIPELINE_PROXY_SECRET` | both | Per-visitor rate limiting through the proxy. |
| `GTM_CALENDLY_WEBHOOK_SIGNING_KEY` | Lion Elite OS | Enables the Calendly webhook. |

Calendly webhook URL:
`<Lion Elite OS origin>/api/gtm-funnels/public/<slug>/calendly-webhook`, event `invitee.created`.

## Running
```bash
npm install --no-audit --no-fund
npm run typecheck
npm run build
BUILDPIPELINE_API_URL=http://localhost:3000 npm start
```
CI runs install, typecheck and build as the `buildpipeline` job in
`.github/workflows/ci-render.yml`.

## Not decided here: where this app is hosted
`buildpipeline.online` is currently served by the Base44 app (see
`base44-bridge/CLAUDE.md`), not by this code. Pointing the domain or a subpath at
this app is an owner decision. Do not move the domain to make this live.
