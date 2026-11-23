# Clinical decision-maker prospecting pilot

Status: documented; not activated.

Tracking: https://github.com/lionelite/lion-elite-os/issues/180

## Outcome
Create a measurable new-clinic acquisition pilot for Lion Elite Clinical. User authorized recording and advancing this strategy on November 3, 2026. This ticket documents executable work; it does not assert that a campaign has launched.

Related: #175 relationship-first positioning, #10 validation framework, #38 coordination hub. Reuse existing BuildPipeline/CRM infrastructure.

## Offer
“Send us the specifications and quantities for one product you already purchase, and we’ll prepare a side-by-side quote with supporting quality documentation.”

Present savings and quality equivalence only when supported for the specific product and comparison. Confirm product availability, intended use, supplier eligibility, documentation, landed cost, and fulfillment terms before prospecting with that offer. Do not market research-use-only products for patient treatment. Keep relationship and long-term service value in the conversation.

## First deliverable: 30 new clinic prospects
- Select one clinic category matched to verified available products.
- Deduplicate against existing CRM and prior outreach; this is a new-prospect pilot.
- Record clinic, official website, service-fit evidence, public business contact path, named owner/purchasing contact where verified, title, source URL/date, verification status, assigned owner, and dated next action.
- A clinic owner is not automatically a confirmed purchasing authority. Mark authority unconfirmed until sourced or confirmed.
- Use business contact channels; do not guess email addresses.
- Keep prospect records, private quotes, supplier economics, and customer details in the private CRM, not this public issue.

## Contact scripts
Routing call:
“Hi, this is Alex with Lion Elite Clinical. Who evaluates suppliers and purchasing options for your clinic?”

First-contact draft:
“Hi [verified name], I noticed [verified relevant service] at [clinic]. Would a pricing and sourcing comparison for one product you already purchase be useful? We can prepare a quote against your specifications and quantities, with supporting documentation, so you can assess whether a switch makes sense.”

Interested reply:
“Which product specifications, order quantity, and delivery requirements should we quote? If you want a savings comparison, you can optionally share your current landed price with identifying details removed.”

After delivering comparison:
Offer a short review with Alex; use the verified scheduling link. Do not invent a calendar URL.

## Pilot execution
- [ ] Verify one fulfillable offer and assemble a comparison template: specifications, quantity, unit/total price, shipping, lead time, documentation, terms, and differences.
- [ ] Deliver 30 evidence-backed new clinic records to the existing private CRM.
- [ ] Confirm purchasing contact or provide a routing-call task for every record.
- [ ] Check sending-domain configuration, delivery/bounce evidence, suppression, and reply capture before launch.
- [ ] Prepare personalized first email and human call task for each eligible clinic.
- [ ] Proposed cadence: day 1 email/routing call; day 3 useful follow-up; day 7 final follow-up. Respect existing frequency rules and stop on reply, opt-out, bounce, or disqualification.
- [ ] Obtain campaign-specific send authorization before releasing external outreach; creating this ticket is not a live-send action.
- [ ] Assign every positive reply an owner and next action within one business day.
- [ ] Review results after the sequence has had time to complete; treat 30 accounts as directional evidence, not a statistically proven winner.

## Funnel and acceptance criteria
Report raw counts and defined rates by campaign/version:
- Attempted, provider-accepted, delivered where confirmed, bounced, unique recipients replying, unique positive replies.
- Reply rate = unique replying recipients / unique delivered recipients; if delivery is unavailable, label accepted-recipient denominator explicitly.
- Positive reply rate uses the same denominator.
- Qualified conversations, comparisons requested/sent, meetings booked/held, orders, and attributed revenue.
- Lead-to-order rate = new purchasing clinics / contacted clinics; report zero denominators as N/A.
- Distinguish automated replies, negative replies, and positive replies.

Done means: usable private CRM records + verified offer + tracked authorized activity + observable outcomes. A ticket, template, or deployed code alone does not constitute campaign success.

## Implementation handoff
Inspect current repository guidance and running systems before changing code. Reuse existing campaign, lead, task, suppression, and analytics components. Post the CRM destination, verified record count, missing fields, evidence of any technical changes/tests, launch status, blockers, and exact next action back to this issue and #38. Do not claim activation from ticket creation alone.


## Comparison worksheet

| Field | Current purchase (buyer supplied) | Proposed supply (verified) |
|---|---|---|
| Product and specifications | Pending | Pending |
| Intended use and eligibility | Pending | Pending |
| Quantity and pack size | Pending | Pending |
| Unit price | Pending | Pending |
| Shipping and other charges | Pending | Pending |
| Total landed price | Pending | Pending |
| Lead time | Pending | Pending |
| Quality documentation reference | Pending | Pending |
| Material differences and terms | Pending | Pending |

Calculate savings only for comparable quantities/specifications: current landed total minus proposed landed total. Percentage savings = difference / current landed total × 100; use N/A for zero or missing current total. Document differences instead of asserting equivalence.
