# BuildPipeline Launch Checklist

Production domain: https://buildpipeline.online

## Code path
- [x] Product-led sales site
- [x] Solo / Agency pricing
- [x] Stripe Checkout endpoint
- [x] Stripe webhook signature verification
- [x] Paid workspace provisioning
- [x] Activation email after successful payment
- [x] Passwordless single-use login links
- [x] Customer account hub
- [x] Stripe Billing Portal
- [x] Self-service onboarding wizard
- [x] First-campaign creation
- [x] Security / Support / Terms / Privacy / Acceptable Use
- [x] Custom-domain root routing
- [x] Launch readiness endpoint + launch status page

## External production switches
These remain fail-closed until configured.

- [ ] Attach buildpipeline.online and www.buildpipeline.online to the Render web service.
- [ ] Point DNS to the records Render supplies.
- [ ] Set PUBLIC_BASE_URL=https://buildpipeline.online.
- [ ] Provision a persistent GTM Postgres database and set DATABASE_URL.
- [ ] Set STRIPE_SECRET_KEY.
- [ ] Create the Solo monthly Stripe price and set GTM_STRIPE_PRICE_SOLO_MONTHLY.
- [ ] Create the Agency monthly Stripe price and set GTM_STRIPE_PRICE_AGENCY_MONTHLY.
- [ ] Configure Stripe webhook endpoint /api/gtm-sales/stripe-webhook and set GTM_STRIPE_WEBHOOK_SECRET.
- [ ] Set RESEND_API_KEY.
- [ ] Verify a BuildPipeline sending domain in Resend and set GTM_EMAIL_FROM.
- [ ] Set Google OAuth credentials if Gmail/Calendar connections are enabled.
- [ ] Set APOLLO_API_KEY for provider-backed prospect sourcing.
- [ ] Configure sender infrastructure before enabling external campaign delivery.

## Launch gate
Do not send paid traffic until:
GET /api/gtm-sales/readiness returns launchReady=true.

Visual verification:
https://buildpipeline.online/launch-status

## Smoke test
1. Open sales site.
2. Open Pricing.
3. Purchase a test subscription in Stripe test mode.
4. Verify webhook creates a BuildPipeline user, subscription, workspace, owner membership, and plan allowances.
5. Verify activation email arrives.
6. Use one-time link.
7. Confirm account page lists the workspace.
8. Finish onboarding.
9. Confirm first campaign exists.
10. Open Billing and verify Stripe Billing Portal opens.
11. Cancel test subscription and confirm lifecycle state updates.
12. Run safe demo and production-readiness checks.
