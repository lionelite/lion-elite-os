# Stripe Checkout by SMS Close Workflow

## Purpose

Standardize the final sales step for Lion Elite Beauty so qualified prospects can move from verbal commitment to secure payment with minimal friction.

## Trial Close

Before presenting the payment link, ask:

> If we were able to answer every question you have and show you exactly how we can help you achieve your goals, how soon would you be ready to move forward?

Pause and listen. Address any remaining concern before presenting payment.

## Verbal Transition

Once the prospect confirms they are ready:

> Perfect. It sounds like this is exactly what you are looking for. I am going to send you a secure Stripe checkout link by text right now. Once you complete it, I will receive the confirmation and we can begin your onboarding immediately. Let me know as soon as it is submitted so we can move to the next step together.

## SMS Payment Message

> Lion Elite Beauty: Here is your secure enrollment link: {{stripe_checkout_url}}. Once payment is complete, reply DONE and we will begin your personalized onboarding. Reply STOP to opt out.

## Required CRM Workflow

1. Representative confirms the prospect's goal, fit, and readiness.
2. Representative selects the correct Lion Elite Beauty offer.
3. Lion Elite OS creates a Stripe Checkout Session for that offer.
4. The checkout URL is stored against the prospect and opportunity record.
5. The SMS is queued through Twilio only after channel authorization and suppression checks pass.
6. The representative remains on the call or active conversation while the prospect completes checkout.
7. Stripe payment confirmation updates the opportunity to `paid`.
8. Lion Elite OS triggers onboarding tasks, portal access, intake forms, welcome communication, and first-call scheduling.
9. Failed or abandoned checkout creates a follow-up task rather than repeated automatic pressure.

## Operating Rules

- All payments are processed through Stripe; representatives must not collect card details directly.
- Use only the approved checkout link for the exact offer discussed.
- Never change pricing, discounts, financing terms, or deliverables without approval.
- Do not send a payment link before discovery, value-building, and the trial close.
- Do not send SMS to suppressed, opted-out, invalid, or unauthorized numbers.
- Record the link sent time, representative, offer, payment result, and next action.
- A payment-success webhook is the source of truth for paid status.
- Customer replies such as STOP must immediately suppress future marketing texts.

## Definition of Done

A qualified prospect can verbally commit, receive the correct Stripe Checkout link by SMS, complete payment securely, and automatically enter the Lion Elite Beauty onboarding workflow with a complete audit trail.