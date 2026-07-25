# Current Client Coaching SMS Campaign

## Objective

Invite current Lion Elite Wellness customers into a discovery-first conversation about Lion Elite Beauty coaching.

The campaign must not assume that every customer needs coaching. Its purpose is to identify goals, uncover gaps in structure or accountability, and offer coaching only when the client expresses interest and is a genuine fit.

## Audience

Include:

- Existing Lion Elite Wellness customers with a valid mobile number.
- Paid or completed orders.
- Customers not already enrolled in Lion Elite Beauty coaching.
- Customers who have not opted out of text messages.
- Customers whose number is not duplicated or suppressed.

Exclude:

- Current Lion Elite Beauty coaching clients.
- Refunded, fraudulent, cancelled, or unresolved orders.
- Contacts without appropriate SMS permission.
- Landlines, invalid numbers, duplicates, and suppressed contacts.
- Anyone who previously replied STOP or requested no marketing.

## Campaign Sequence

### Message 1 — Discovery opener

> Hey {{first_name}}, it’s Alex from Lion Elite. You’ve already taken a step toward your goals with us, so I wanted to ask—what’s the biggest fitness or body-composition result you’re trying to achieve right now? Reply with your goal. Reply STOP to opt out.

Purpose:

- Begin with a relevant customer relationship.
- Ask a single clarifying question.
- Avoid pitching coaching before understanding the goal.

### Interested reply — Qualification

> Got it. What do you feel is the biggest thing holding you back right now: having the right plan, staying consistent, nutrition, accountability, or something else?

### Qualified reply — Value bridge

> That makes sense. Lion Elite Beauty is built to give you a personalized roadmap, accountability, and ongoing adjustments based on your goal and schedule. If we were able to answer every question you have and show you exactly how we can help you achieve your goals, how soon would you be ready to move forward?

### Ready now — Payment transition

Representative talk track:

> Perfect. I’m sending you a secure Stripe checkout link now. Once payment is complete, reply DONE and we’ll begin your onboarding.

SMS:

> Lion Elite Beauty: Here’s your secure enrollment link: {{stripe_checkout_url}}. Once payment is complete, reply DONE and we’ll begin building your personalized coaching plan. Reply STOP to opt out.

### Not ready — Follow-up

> No problem. What would you still need to see or understand before feeling confident moving forward?

## Automation Rules

1. Import only first-party customer records.
2. Normalize all phone numbers to E.164.
3. Deduplicate by normalized phone number.
4. Exclude active coaching clients.
5. Require SMS eligibility and suppression checks before queueing.
6. Send Message 1 only during approved local sending hours.
7. Stop all automated campaign messages immediately after any reply.
8. STOP, UNSUBSCRIBE, CANCEL, END, and QUIT must suppress the contact immediately.
9. HELP must return brand and support information.
10. Stripe links are sent only after the client indicates interest and a representative confirms fit.
11. Stripe webhook payment confirmation, not the word DONE alone, changes the client to paid.
12. Successful payment triggers onboarding, portal access, intake forms, and scheduling.
13. Never collect card details by call, SMS, DM, or email.

## CRM Stages

- CUSTOMER_ELIGIBLE
- SMS_READY
- SMS_SENT
- REPLIED
- GOAL_IDENTIFIED
- QUALIFIED_FOR_COACHING
- STRIPE_LINK_SENT
- PAYMENT_PENDING
- COACHING_CLIENT
- FOLLOW_UP
- NURTURE
- DO_NOT_CONTACT

## Initial Rollout

Do not launch to the full customer list immediately.

1. Send to internal test numbers.
2. Confirm sender identity, reply handling, STOP handling, and Stripe-link rendering.
3. Run a controlled batch of 10 eligible customers.
4. Review delivery, replies, opt-outs, booked calls, and payments.
5. Expand only after the first batch performs correctly.

## Core KPIs

- Delivered rate
- Reply rate
- Goal-identification rate
- Qualified-conversation rate
- Stripe-link rate
- Payment conversion rate
- Opt-out rate
- Revenue generated
- Revenue per delivered message
