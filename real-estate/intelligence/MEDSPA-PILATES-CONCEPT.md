# Med Spa + Pilates Luxury Concept — Cleveland Market Intelligence

A Lion Elite Beauty flagship: a **membership-driven luxury destination**
combining med-spa aesthetics, medically-supervised weight management,
reformer Pilates, and recovery — a Miami-upscale feel brought to affluent
Cleveland suburbs. `src/commercial-concept.js` scores candidate sites and
turns a competitor catalog into white-space. `npm run real-estate:concept`
runs the demo.

## What the intelligence found (July 2026, public web search)

- **Med-spa market is deep but mid-tier.** 170+ med spas in the metro;
  the named east/west operators (Cleveland Primecare — Beachwood; The Well
  House — Westlake/Rocky River; Urban Haven — Cleveland Heights) read as
  **mid to upscale, not luxury.** No true luxury-tier operator surfaced.
- **Pilates is present in the affluent burbs but single-service.** Club
  Pilates (Chagrin Falls), Studio One (Bay Village/Avon/Chagrin Falls),
  White Cloud (Van Aken/Chagrin Falls), ab&flow, Callie's — good boutique
  reformer studios, but **none combine Pilates with med-spa aesthetics.**
- **GLP-1 weight management (semaglutide/tirzepatide) is the fastest-growing
  med-spa service** in the market ($299–$599/mo range). High demand,
  membership-friendly, and a natural anchor line.
- **Two open lanes:** (1) the **luxury tier** is unclaimed; (2) the
  **integrated destination** (aesthetics + Pilates + recovery under one
  membership) is unclaimed. The engine flags both automatically.

## Site scoring

`scoreLocation(location, competitors)` weights demographics (0.34),
competition (0.24), site fit (0.24), and multi-service synergy (0.18).
Highest-scoring demo sites: **Pepper Pike, Beachwood, Chagrin Falls** (all
tier-1 affluent, east side). Feed real listings (sqft, parking, visibility,
medical zoning, nearby competitor count, and — best — verified median
household income) for live ranking.

Target trade areas (coarse affluence tier in `TARGET_SUBURBS`): Pepper
Pike, Hunting Valley, Gates Mills, Moreland Hills, Chagrin Falls, Beachwood,
Orange (tier 1 east); Shaker Heights/Van Aken, Woodmere, Solon (tier 2
east); Rocky River, Bay Village (tier 1 west); Westlake, Avon (tier 2 west).

## Competitor gap analysis

`analyzeCompetitors(catalog)` returns type/tier distribution, membership
share, count of operators combining aesthetics + Pilates, top services, and
an explicit **white-space** list. Seed catalog: `data/cleveland-competitors.seed.json`.

## Caveats — verify before committing capital

- **Competitor tiers/services/pricing in the seed file are a first-pass
  structuring**, not a finished audit. This environment can't crawl
  Maps/Yelp; do a real on-the-ground + online audit (each competitor's
  site, Google Business, Yelp, pricing, reviews, membership terms) and
  expand the catalog.
- **Demographic tiers are coarse.** Pull current census / Esri tapestry
  household-income and daytime-population for the exact trade area.
- **Regulatory, and this matters:** a med spa offering injectables and
  GLP-1 weight management is a **licensed medical practice** — it needs a
  medical director / supervising physician, proper scope-of-practice, a
  legitimate compounding pharmacy, and state (Ohio Medical/Nursing Board)
  compliance. That is a **separate entity and regulatory posture** from
  lionelitewellness.com's research-use-only storefront. Do **not** market
  or supply the RUO research products as med-spa treatments; keep the two
  legally distinct. Confirm structure with a healthcare attorney and CPA.
- Retail/medical **zoning and build-out** (aesthetics rooms + reformer
  floor + recovery) must be confirmed for any specific building — this ties
  back into the real-estate acquisition engine (`scoring.js`) for the
  property side of the deal.
