# Lion Elite Wellness Order Fulfillment Workflow

## Current verified state

- The website repository has a scheduled GitHub Actions workflow that reads `🛒 New Order` emails from `orders@lionelitewellness.com` and deducts inventory.
- That workflow does **not** create shipping labels, sync tracking, mark orders fulfilled, or send payment/shipping confirmations.
- Gmail shows that customer-facing confirmation emails are being generated for new orders, but they are copied to `info@lionelitewellness.com`; the system still requires payment confirmation and fulfillment handling.
- Pirate Ship does not provide a public API. Label automation must use its supported store integration rather than a custom API call.

## Required production workflow

1. Website creates the order and sends the internal order email.
2. Payment processor confirms payment.
3. Paid order is made available to the connected ecommerce platform/store integration.
4. Pirate Ship imports only paid, unfulfilled orders.
5. Staff purchases the label in Pirate Ship.
6. Pirate Ship writes the tracking number back to the connected store and marks the order fulfilled.
7. The store or Pirate Ship sends the shipping confirmation to the customer.
8. LionOS audits Gmail for any paid order that has no shipping confirmation within the service-level window.

## Pirate Ship setup

In Pirate Ship:

1. Open **Settings → Integrations**.
2. Choose **Connect New Source**.
3. Connect the ecommerce platform that actually owns the orders.
4. Configure the import filter to include only **Paid** and **Unfulfilled** orders.
5. Choose one customer notification source only:
   - Shopify/store notification, or
   - Pirate Ship notification.
6. Do not enable both, to avoid duplicate tracking emails.

## Important limitation

The current Lion Elite website appears to be an Orchids-hosted/custom storefront rather than a verified Shopify store. Pirate Ship cannot be made to create labels directly from GitHub or Gmail because it has no public API. Full label creation automation requires either:

- connecting a supported ecommerce platform directly to Pirate Ship, or
- changing shipping providers to one with a supported API.

## Gmail audit rules

For every new order:

- `Order Confirmed` means the order was received, not necessarily paid.
- A Stripe receipt or manual Cash App verification establishes payment.
- `Payment received` confirms payment but does not prove that a label exists.
- `Your Order is On Its Way` must contain a valid tracking number before the order is considered fulfilled.

## Current order audit snapshot — July 17, 2026

- `LEW-S2NRZB` — Shannon Walls: Stripe payment confirmed and a separate payment confirmation email was sent. Label/tracking still needs verification.
- `LEW-HRF1H2` — Makia Underwood: order confirmation exists, but payment confirmation and label/tracking were not verified from Gmail at the time of audit.
- `LEW-V58WV4` — DeCarla Reed: payment/shipping confirmation and a Pirate Ship purchase receipt exist.

## Next engineering step

Add a fulfillment audit worker to LionOS that stores, for each order:

- order ID
- customer email
- order total
- payment status and timestamp
- payment processor reference
- shipping label status
- carrier
- tracking number
- shipping confirmation timestamp
- fulfillment exceptions

The worker should alert only when a paid order has no tracking number after the defined fulfillment window.