# Lion Elite Wellness Order Fulfillment Workflow

## Current verified state

- The website repository has a scheduled GitHub Actions workflow that reads new-order emails from the authorized order mailbox and deducts inventory.
- That workflow does **not** create shipping labels, sync tracking, mark orders fulfilled, or send shipping confirmations.
- A customer payment confirmation does not prove that a shipping label or tracking number exists.
- Pirate Ship's official support documentation currently identifies three supported ways to create labels: manual address entry, spreadsheet upload, or a connected ecommerce platform. No supported public API has been verified, so LionOS must not depend on undocumented endpoints.
- Official reference: https://support.pirateship.com/en/articles/1067807-what-is-pirate-ship

## Required production workflow

1. The storefront creates the order and records a non-sensitive internal order reference.
2. Stripe confirms card payments through a verified, idempotent webhook. Zelle, Cash App, and other manual payments require an authorized confirmation event.
3. Only a verified paid order becomes eligible for fulfillment.
4. The paid order reaches Pirate Ship through a supported ecommerce integration or a controlled manual/spreadsheet import.
5. Staff purchases the label in Pirate Ship.
6. Tracking is captured in the system of record and the order moves to fulfilled.
7. Exactly one authorized notification source sends the shipping confirmation.
8. LionOS audits for any paid order that lacks tracking after the defined service-level window.

## Pirate Ship setup

In Pirate Ship:

1. Open **Settings → Integrations**.
2. Choose **Connect New Source**.
3. Connect the ecommerce platform that actually owns the orders, if it is supported.
4. Configure imports to include only paid, unfulfilled orders.
5. Choose one customer tracking-notification source:
   - the storefront, or
   - Pirate Ship.
6. Do not enable duplicate tracking notifications.

If the live Orchids storefront cannot connect directly, use a controlled spreadsheet import as the short-term supported path while evaluating a shipping provider with a documented API.

## Fulfillment state rules

- 'order_received': the order exists; payment is not yet established.
- 'payment_confirmed': a verified provider webhook or authorized manual confirmation establishes payment.
- 'label_created': a carrier label and tracking number exist.
- 'fulfilled': the package was handed to the carrier and tracking was stored.
- 'shipping_confirmation_sent': one customer notification containing the valid carrier and tracking number was sent.
- 'delivered': the carrier reports delivery.
- 'exception': the order exceeded a service-level window or the carrier reported a problem.

A payment-confirmation email must never be treated as proof of fulfillment. A postage receipt must never be treated as proof that the correct customer received tracking.

## Privacy and auditability

Customer names, email addresses, street addresses, full order identifiers, payment references, and order-level snapshots must not be committed to GitHub documents, issues, logs, or test fixtures.

The production datastore may retain only the fields needed for fulfillment and audit, protected by access controls and retention rules:

- internal order key
- customer reference
- total and currency
- payment state and timestamp
- payment-provider reference
- fulfillment state and timestamps
- carrier and tracking number
- notification state
- exception reason codes

Logs and GitHub reports should contain aggregate counts, non-sensitive reason codes, and synthetic identifiers only.

## Next engineering step

Add a fulfillment audit worker that:

1. Ingests verified payment and fulfillment events idempotently.
2. Creates an exception when a paid order lacks tracking after the configured service-level window.
3. Prevents duplicate payment and shipping confirmations.
4. Starts a retention/reorder timer only after delivery.
5. Uses synthetic fixtures in CI and never writes customer PII to repository output.
