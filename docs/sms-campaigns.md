# SMS ("text") campaigns — consumer research reorder

Owner-authorized (amendment 2026-07-27) SMS path for texting **existing,
consented** research customers a reorder reminder. Built fail-closed and
TCPA-gated. This doc is the map + the enablement checklist.

## The one campaign

`client_research_reorder_sms` — reminds an existing research customer that
previously purchased research-grade items are available to reorder. RUO
framing, consent-gated, quiet-hours-bound.

## Guardrails (enforced in code — a campaign can't skip them)

| Control | Where |
|---|---|
| Prior express written consent per recipient (`smsConsent === true`) | `lib/sms/sms-selectors.js` |
| STOP opt-out honored + suppression | selector + every message carries "Reply STOP to opt out." |
| Quiet hours only, 8am–9pm recipient local time (unknown time → skipped) | `withinQuietHours` in `lib/sms/sms-campaigns.js` |
| E.164 mobile validation | `lib/sms/sms-selectors.js` |
| 45-day reorder cooldown | campaign registry |
| RUO content (no human-use/dosing/transformation) | `lib/sms/sms-message.js` via `lib/social/social-compliance.js` |
| Transactional daily quota + Redis kill switch | shared outreach controls |
| Sender identification | every message is prefixed "Lion Elite Wellness:" |

`assertSafeguards()` throws if a campaign omits `consentRequired`, `optOut`,
`quietHours`, `suppressionCheck`, `dailyQuota`, or `killSwitch`, or if it isn't
`research-only`.

## What a message looks like

> Lion Elite Wellness: Sam, your previously purchased research-grade items are
> available to reorder for laboratory research purposes only. Reorder:
> https://… Reply STOP to opt out.

Compliance-validated; drifting into human-use/benefit language makes the
builder return `approved: false`.

## What's built vs. what the owner still must do

**Built & tested** (`test/sms-campaigns.test.js`): campaign registry +
safeguard invariants, the RUO reorder message builder, and the consent /
opt-out / quiet-hours / cooldown / E.164 recipient selector.

**Owner actions to actually send (none done by Claude):**
1. Merge the SMS delivery provider (see open PRs #45 Twilio + #47 consent-gated
   customer SMS) or wire `lib/sms/*` to a Twilio delivery module.
2. Create/connect the Twilio account + number, register the campaign for A2P
   10DLC, and set `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
   `TWILIO_MESSAGING_SERVICE_SID` on the worker.
3. Load customer records that carry **verified SMS marketing consent**, an
   E.164 mobile, and a resolvable local timezone.
4. Set `SMS_SEND_ENABLED=true` **only after** a self-addressed test — Claude
   does not flip this or add the Twilio payment method.

No text is sent by building any of this; the pipeline stays fail-closed on the
owner-set credentials and per-recipient consent.

## Not authorized

Cold texting, non-consented numbers, B2B texting, and any non-reorder message
type remain disallowed without a fresh owner decision.
