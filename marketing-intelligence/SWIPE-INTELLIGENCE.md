# Swipe Intelligence — reverse-engineer winners, adapt, let our results decide

A structured intelligence system for Lion Elite marketing. Instead of reading
generic "how to run Meta Ads" articles, we study **operators and case-study
libraries that expose real brands, products, creatives, funnels, and measured
results** — extract the patterns winners share, adapt them (never copy), launch
our own tests, and let **our own results** decide which patterns become
permanent SOPs.

## The loop

```
  independent case-study libraries / operators
        │  (Replo, Triple Whale, AdEspresso, Madgicx, …)
        ▼
  swipe database  ──►  pattern extraction  ──►  candidate SOPs
   (one row per            (what winners             (things to TEST)
    proven system)          share)                        │
                                                          ▼
                                              Lion Elite launches a test
                                                          │
                                                          ▼
                                          OUR measured result decides:
                                          confirm (keep)  or  retire (kill)
                                                          │
                                                          ▼
                                              permanent Lion Elite SOP
```

## What each row captures (the swipe file)

Per proven example — product, price/AOV (when available), industry, offer,
opening hook, visual style, format (**UGC vs founder vs static vs
demonstration vs testimonial**), headline, CTA, landing-page structure, social
proof, reported spend/performance, source, and **why we think it worked**.

**Ad + landing page are treated as ONE system.** Congruence between the
winning ad message and the page it lands on is a first-class field
(`funnel.adLandingCongruence`) and a tracked pattern — Replo's cases keep
showing lifts from exactly that alignment.

## Integrity rules (enforced in code)

1. **No fabrication.** Fields we haven't personally inspected (a real ad's
   hook/headline/CTA, the landing-page structure) stay `null` and are listed
   in `research.gaps`. The report prints those gaps every run.
2. **Sourced ≠ verified.** Every performance figure carries
   `verificationStatus`. Seeded numbers are `reported-by-source` — the
   case-study publisher's claim, not our independent measurement.
3. **Borrowed evidence never confirms an SOP.** A pattern mined from other
   brands' winners is only ever a *candidate*. `sop-ledger.js` refuses to
   promote it to a permanent SOP until a **positive Lion Elite result** is on
   record.

## Files

| File | Role |
|---|---|
| `src/swipe-schema.js` | Row contract + validator (errors vs honesty warnings), `isWinner`, `blankEntry` |
| `data/swipe-database.json` | Seeded swipe rows (the cited case studies, honestly gapped) |
| `src/swipe-database.js` | Loader that validates every row and splits winners/invalid/warnings |
| `src/pattern-extraction.js` | Finds shared levers/formats/price-bands/congruence across winners |
| `src/sop-ledger.js` | candidate → testing → (our result) → confirmed / retired lifecycle |
| `src/report.js` | `npm run swipe:report` — winners, patterns, candidate SOPs, research gaps |

## Commands

```bash
npm run swipe:report   # print winners, shared patterns, candidate SOPs, gaps
npm test               # includes marketing-intelligence/test/*.test.js
```

## Seeded winners (all figures reported by the cited library, not verified by us)

| Brand | Industry | Reported result | Source | Named lever |
|---|---|---|---|---|
| Cornbread Hemp | CBD / hemp | CVR +117%, CAC −33% | Replo | landing-page / CRO |
| Healthy Metal | (to research) | CVR +67% | Replo | landing-page testing |
| Portland Leather Goods | leather goods | best-seller sales +263% YoY | Triple Whale | attribution / best-seller scaling |
| OhSnap | phone accessories | CPA −37%, sales +147% | Triple Whale | attribution / demo creative |
| EcoBio Boutique | sustainable goods | net profit +311% YoY | Triple Whale | attribution / spend discipline |
| Emma Kate Co. | stationery | sales 3× YoY | AdEspresso | ad-design testing |
| GlobeIn | artisan subscription | revenue 2× | AdEspresso | audience testing + retargeting |

## Next research (fill the gaps)

For each row: inspect the actual ad(s) and landing page and fill
`creative.openingHook`, `creative.format`, `creative.headline`, `creative.cta`,
`funnel.landingPageStructure`, `funnel.socialProof`, `price`, and the exact
case-study `source.url`. Additional libraries to mine: **Madgicx** (ROAS /
spend-scaling / retargeting outcomes) and any operator teardown that shows a
real creative next to a measured result. Then re-run `npm run swipe:report` —
patterns sharpen as sample size and creative detail grow.
