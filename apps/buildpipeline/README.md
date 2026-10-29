# BuildPipeline VSL Funnel

Production-ready drop-in Next.js App Router module for BuildPipeline.

## Funnel stages
Traffic → VSL → Application → Booking → Confirmation → Follow-up

## Included
- Timed/delayed CTA
- Lead capture
- Qualification questions
- Booking handoff
- Funnel event tracking endpoint
- Responsive BuildPipeline-styled UI
- Demo route: `/funnel/demo`

## Integration targets
Replace `demoFunnel` with BuildPipeline's funnel database/config model. Persist `/api/funnel-events` into the analytics store. Replace the generic booking URL with the connected calendar provider. Hook `lead_qualified` and `booking_click` into CRM stages and SMS/email automation.
