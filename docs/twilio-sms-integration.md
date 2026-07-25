# Twilio SMS integration

Lion Elite OS can dispatch validated `sms` outreach queue items through a Twilio Messaging Service. SMS uses the same prospect validation, authorization, suppression, idempotency, queue, delivery-status, and audit flow as email.

## Required owner setup

1. Create or select a Twilio account.
2. Create a Twilio Messaging Service and attach an SMS-capable sender.
3. Complete all registration required by Twilio and the destination market before sending application-to-person traffic.
4. Configure the Messaging Service compliance and opt-out behavior, including STOP and HELP responses.
5. In the `lion-elite-outreach-worker` Render service, add these secret environment variables:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_MESSAGING_SERVICE_SID`
6. Optional: add `TWILIO_STATUS_CALLBACK_URL` for delivery-status callbacks.
7. Keep `SMS_SEND_ENABLED=false` until the sender, registration, consent records, suppression handling, and test recipient are verified.
8. Set `SMS_SEND_ENABLED=true` only when live SMS delivery is approved.

Never commit Twilio credentials to GitHub.

## Queue contract

An authorized queue item must use:

```json
{
  "channel": "sms",
  "recipient": "+13055551234",
  "body": "Message text"
}
```

Phone numbers must use E.164 format. Delivery fails closed when authorization is missing, the prospect is suppressed or opted out, the number is invalid, the body is empty, the body exceeds 1,600 characters, credentials are absent, or `SMS_SEND_ENABLED` is not `true`.

## Recommended first campaign

Target only first-party Lion Elite Wellness customers with documented permission for marketing texts. Exclude existing Lion Elite Beauty coaching clients, suppressed contacts, opt-outs, invalid numbers, and anyone without appropriate SMS consent.

Use a discovery-first message rather than a hard pitch. Replies should be reviewed by a representative and moved into the coaching qualification workflow.

## Remaining inbound work

Outbound delivery is implemented. Before a broad campaign, add a Twilio inbound-message webhook that:

- Validates Twilio request signatures.
- Stores inbound messages and delivery callbacks.
- Immediately suppresses STOP-style opt-outs.
- Records HELP requests.
- Matches replies to prospects by normalized phone number.
- Stops pending sequences after a reply.
- Creates a representative follow-up task.
