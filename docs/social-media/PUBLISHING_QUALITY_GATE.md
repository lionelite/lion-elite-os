# Lion Elite Social Media Publishing Quality Gate

Status: **MANDATORY — NO AUTO-PUBLISH BYPASS**

Applies to Lion Elite Wellness social publishing and should be reused by future Lion Elite brands connected to the publishing pipeline.

## Core Rule

No social asset is published merely because it exists or is scheduled. Every post must pass the complete pre-publish quality gate. If any check fails, the asset must be refined, re-exported, and validated again. Continue the refinement loop until every applicable check passes; only then may the post be published automatically.

## Required Pre-Publish Checks

1. **Resolution and clarity**
   - No pixelation, blur, low-resolution source material, compression artifacts, stretching, or unintended cropping.
   - Text and product labels must remain crisp at normal mobile viewing size.

2. **Platform dimensions / safe areas**
   - Instagram feed/carousel target: 1080x1350 where appropriate.
   - Reels / Stories / TikTok target: 1080x1920 vertical.
   - Keep important text, logos, faces, products, and CTAs inside platform-safe areas.

3. **Media format compatibility**
   - Validate the exact media format accepted by the destination network before scheduling.
   - Current TikTok Business photo publishing requires JPEG/JPG/WebP; do not send PNG when unsupported.
   - Reels require video; Stories require supported media.

4. **Brand accuracy**
   - Use the canonical Lion Elite Wellness logo/brand treatment.
   - Maintain premium visual presentation and consistent brand identity.
   - Product/vial imagery must use accurate Lion Elite assets whenever the post represents an actual Lion Elite product.

5. **Product label accuracy**
   - Product names, quantities, spelling, label placement, and vial appearance must match approved product assets.
   - Current label convention: top-right product box contains only the product/blend name; quantity appears only in the left-middle QUANTITY section.

6. **Copy and visual QA**
   - No spelling, grammar, duplicated-text, malformed-character, layout, or legibility errors.
   - No obvious AI-generation artifacts.
   - No text collisions, clipping, unreadably small copy, or poor contrast.

7. **Scientific / compliance review**
   - Claims must accurately reflect the intended educational/research positioning and available evidence.
   - Do not rely on disclaimers to cure otherwise noncompliant claims.
   - Avoid unsupported medical, therapeutic, disease-treatment, safety, efficacy, or guaranteed-result claims.
   - Ensure the creative, caption, CTA, landing-page context, and overall marketing message are evaluated together.

8. **Content quality / campaign fit**
   - Creative must meet a premium Lion Elite standard, not merely a minimum technical standard.
   - Post must have a defined campaign role: education, authority, curiosity, trust, engagement, or conversion.
   - Avoid repetitive consecutive product-info advertisements when stronger educational or authority content is available.

9. **Final platform validation**
   - Validate network, content type, media requirements, caption limits, scheduled time, timezone, and media accessibility before publish.
   - A scheduling/API validation error is a failed gate, not a successful post.

## Automated Refinement Loop

`CREATE -> VALIDATE -> FAIL? -> REFINE -> RE-EXPORT -> VALIDATE AGAIN -> PASS -> SCHEDULE/PUBLISH`

The system must never convert a failed validation into a publish decision. There is no fixed retry count for creative-quality failures; refinement continues until the asset passes or is explicitly abandoned/replaced.

## Metricool / Lion Elite Wellness Current Context

- Metricool brand: Lion Elite Wellness
- Timezone: America/New_York
- Connected networks currently visible: Instagram, LinkedIn, TikTok
- Publishing should use network-specific creative rather than blindly recycling the same asset everywhere.
- Audience timing data should be consulted instead of using a blanket posting hour when possible.

## Campaign Principle

Primary funnel:

**Education -> Authority -> Curiosity -> Trust -> Conversion**

Reels/short-form video should be treated as a primary growth format where suitable, supported by high-quality educational feed/carousel content, research breakdowns, mechanisms/pathways, myth-vs-fact, founder/brand authority, quality/testing/transparency, FAQs, and conversion-oriented CTAs.

## Enforcement

This document is a standing operational requirement for Lion Elite social automation. Future automation, agents, content generators, schedulers, and Metricool integrations must treat this quality gate as a blocking precondition to publishing.