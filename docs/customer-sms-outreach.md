# Customer SMS Outreach

This workflow retrieves Shopify orders from the previous 45 days, keeps only customers with explicit SMS marketing consent, deduplicates recipients by phone number, previews the campaign, and sends through Twilio only when the `--send` flag is supplied.

## Required environment variables

```bash
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_...
SHOPIFY_API_VERSION=2026-04
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_MESSAGING_SERVICE_SID=MG...
```

`TWILIO_FROM_NUMBER` may be used instead of `TWILIO_MESSAGING_SERVICE_SID`.

Optional:

```bash
SMS_OUTREACH_DAYS=45
SMS_OUTREACH_MESSAGE="Hi {{firstName}}, ... Reply STOP to opt out."
TWILIO_STATUS_CALLBACK_URL=https://your-service.example.com/webhooks/twilio/status
```

## Preview before sending

```bash
npm run sms:preview
```

The preview returns eligible recipients, skipped totals, and the personalized message without transmitting anything.

## Send

```bash
npm run sms:send
```

## Safety rules

- A recipient is eligible only when Shopify reports the customer's SMS marketing state as `subscribed` or `confirmed_opt_in`.
- Customers without consent, without a valid phone number, or outside the 45-day window are skipped.
- Duplicate phone numbers receive one message based on the most recent order.
- The default message identifies Lion Elite Wellness and includes `Reply STOP to opt out.`
- Sending is fail-closed: the normal command is a dry run, and live delivery requires the explicit `--send` flag plus Twilio credentials.

## Deployment checklist

1. Create or connect a Twilio account and Messaging Service.
2. Complete any required sender registration and campaign approval for the countries being messaged.
3. Add the environment variables to the deployed LionOS service or secure job runner.
4. Run `npm run sms:preview` and review the list.
5. Run `npm run sms:send` only after confirming the audience and copy.
6. Keep Twilio opt-out handling enabled and maintain suppression records across every marketing channel.
