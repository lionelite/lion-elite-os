# Paid Ads Launch Playbook — scale the organic proof

Six months of organic + affiliate traction is the signal to add paid. This is
the launch-ready plan. **Nothing here spends money or publishes an ad** — the
money actions are owner-only and marked so.

## The one rule that protects the whole business

**Do NOT run peptide / research-compound ads on Meta, Google, or TikTok.** They
prohibit unsafe-supplement / research-chemical advertising; an RUO disclaimer
does not exempt the product category, and a violation can **permanently ban the
ad account** — potentially taking shared business assets (including the Beauty
brand) down with it. `lib/ads/ad-launch-plan.js` enforces this: a
Wellness/Meta plan returns `eligible:false` and routes elsewhere.

## Two lanes

| Lane | Brand | Platform | Status |
|---|---|---|---|
| **Meta scale engine** | Lion Elite Beauty (coaching/training — a service) | Meta (IG/FB) | Eligible ✅ |
| **Research supply** | Lion Elite Wellness (peptides, RUO) | Compliant channels only (opted-in email to research buyers, COA-forward landing page, direct/affiliate) | NOT for Meta/Google/TikTok ❌ |

Scale today via **Beauty coaching on Meta**. Grow Wellness through the governed
RUO email campaigns (`docs/outreach-campaigns.md`) and its own site — never a
prohibited-category ad.

## Beauty Meta campaign (ready to load)

- **Objective:** Sales/Conversions once the pixel has data; start with the
  broadest audience and let Advantage+ find buyers.
- **Structure (CBO):** 3 ad sets — `broad` (primary scaling), `interest`
  (coaching/fitness/accountability), `retargeting` (30-day site visitors +
  engagers, small budget, highest ROAS).
- **Creative testing:** ship **3 ad variants** (in `lib/ads/ad-copy.js`, all
  compliance-passed), scale the winner, kill the rest — ad-design testing is a
  top pattern among proven winners.
- **Budget:** start where you can afford to lose while learning (e.g.
  $20–50/day), scale the winner only.

## Ad + landing page are ONE system

The strongest swipe-file pattern: the landing page headline must **echo the
winning ad's promise**. Point ads at a coaching landing page whose hero repeats
the ad hook — don't send paid clicks to a generic homepage.

## Tracking (non-negotiable — attribution is the #1 winner lever)

Every ad URL carries UTMs (`buildUtm` in `lib/ads/ad-launch-plan.js`) and the
Meta pixel / Conversions API must be firing before spend. No tracking → no
scaling decisions.

## Owner-only go-live checklist (money actions — Claude does not do these)

1. Connect billing / payment in Meta Ads Manager.
2. Install the Meta pixel / CAPI on the Beauty landing site; verify events.
3. Load the approved Beauty ad variants + creative, set the daily budget, and
   press **Publish**.

## What's built here

- `lib/ads/ad-copy.js` — 3 Beauty (coaching) + 2 Wellness (RUO) ad variants,
  each validated through the fail-closed compliance engine.
- `lib/ads/ad-launch-plan.js` — platform-eligibility gate, campaign structure,
  UTM builder.
- `test/ads-launch.test.js` — proves the copy passes compliance and that the
  peptide-ads-on-Meta gate blocks.
