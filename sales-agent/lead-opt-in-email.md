# Immediate LEW Opt-In Email

Status: required Sales Agent behavior.

When a new Lion Elite Wellness prospect explicitly opts into email marketing, send this email immediately after consent is recorded.

## Trigger
- Brand = Lion Elite Wellness
- New lead/member signup
- `email_marketing_opt_in == true`
- Address is not suppressed, bounced, or unsubscribed

## Immediate Email
**Subject:** Welcome to Lion Elite Wellness, {{first_name}}

Hey {{first_name}},

Alex from Lion Elite Wellness here. I saw you just joined and wanted to personally reach out.

What originally brought you to us, and what area of peptide research are you most interested in right now?

Reply directly to this email and I’ll point you toward the most relevant research information and products instead of making you sort through the entire catalog.

Alex
Lion Elite Wellness

For research purposes only. Not for human consumption.

## Funnel Progression
After send, set funnel stage to `CONTACT`.
On reply, move to `DISCOVERY`, then continue:

`CONTACT -> DISCOVERY -> QUALIFY -> MATCH -> VALUE -> OFFER -> CLOSE -> FOLLOW-UP`

## Logging
Record:
- `lead_id`
- `email_sent_at`
- `delivery_status`
- `reply_received_at`
- `current_funnel_stage`
- `source`
- `campaign = lew_immediate_optin_welcome`

## Guardrails
- Never send without explicit email marketing consent.
- Never send to suppressed/unsubscribed/bounced addresses.
- Do not provide dosing, reconstitution, treatment, human-use, or guaranteed outcome guidance.
- Keep Lion Elite Wellness research-only positioning in every downstream Sales Agent message.
