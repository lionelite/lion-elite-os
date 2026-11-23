# Discovery call — the only script you need

One goal: leave the call with enough facts to run `npm run agency:plan` and get
`ready-to-propose`. Nothing else. You are not demoing, not describing
architecture, and not quoting.

The engine needs exactly these. Anything missing comes back as a gap and blocks
the quote, so collect all of them.

| Field | Ask it like this |
|---|---|
| `monthlyInboundLeads` | "In a normal month, how many people reach out to you in total — calls, forms, emails, referrals, marketplace, all of it?" |
| `missedLeadRate` | "Of those, what share never gets contacted at all, or gets contacted so late it's gone?" |
| `currentCloseRate` | "When someone *does* get properly worked, what share become customers?" |
| `averageCustomerValue` | "What's one customer worth to you in the first year?" |
| `manualFollowUpHoursWeekly` | "How many hours a week does your team spend chasing leads by hand?" |
| `loadedHourlyCost` | "What does an hour of that person's time cost you, fully loaded?" |
| `decisionMakerEngaged` | "Besides you, does anyone else need to approve a spend like this?" |
| `verticalId` | Which target vertical they are |
| `channelCount` | How many distinct intake channels exist |
| `legacySystemWithoutApi` | "What system holds your customer records today?" |

## The three questions that decide everything

1. **"Walk me through what happens when a new lead comes in right now."**
   Let them talk. The leak names itself, usually in the third sentence.
2. **"What happens to the ones nobody gets to?"**
   The answer is almost always "nothing" or "we get to them eventually". That
   is the product.
3. **"If you closed one more customer a month, what's that worth?"**
   Their own number, in their own mouth. Use it in the proposal verbatim.

## Say these out loud on the call

- **Fixed price.** "The price doesn't move with hours. You'll know the number
  before we start."
- **Deposit.** "50–70% up front, balance on final acceptance."
- **No guarantee.** "I won't guarantee you a revenue figure. I'll guarantee the
  system, the acceptance criteria, and reporting that shows you what it actually
  produced." Say it before they ask.
- **Scope.** Run anything they add through `npm run agency:scope -- "<what they
  said>"`. If it declines, decline it on the call, with the reason. Do not take
  it away to "look into".

## Do not

- Do not quote a price on the call. Run the engine first.
- Do not promise an integration you have not confirmed has an API.
- Do not agree to hourly. It is a disqualifier, not a negotiation.
- Do not mention who writes the code. It is not relevant to what they are buying.

## After the call

```bash
# write the facts into a client file, then:
npm run agency:plan -- --client agency/clients/<ref>.json
npm run agency:proposal -- --client agency/clients/<ref>.json > /tmp/<ref>-proposal.md
npm run agency:internal -- --client agency/clients/<ref>.json > /tmp/<ref>-internal.md
```

If the engine says `discovery-incomplete`, you missed a fact. Get it before you
quote — quoting on a guess is how you underprice.
