# LionOS Auto Social Publishing Specification

## Objective
Automatically generate, validate, schedule, and publish daily content for Lion Elite Wellness, Lion Elite Beauty, and AlexTheLionLifts through an authorized social scheduling provider such as Metricool.

## Required behavior

LionOS should run the following pipeline automatically:

`generate -> brand rules -> compliance validation -> media attachment -> schedule -> publish -> capture URL/status -> pull analytics`

The system should not require daily manual approval for routine content that passes the approved brand and compliance rules.

## Brand rules

### Lion Elite Wellness
- Research education only.
- No human-use instructions.
- No dosing or administration guidance.
- No treatment, cure, or unsupported medical claims.
- Use research-only language consistently.
- Add `For research purposes only. Not for human consumption.` where appropriate.
- Any content that fails compliance validation must be blocked from auto-publishing and flagged for review.

### Lion Elite Beauty
- Maintain premium coaching positioning.
- Focus on personalized strategy, accountability, structure, transformation, progress, and premium client experience.
- No unsupported outcome guarantees.

### AlexTheLionLifts
- Personal/founder brand content.
- Pillars: fitness, discipline, entrepreneurship, leadership, lifestyle, business-building, behind-the-scenes execution.

## Daily publishing targets

Generate and schedule at minimum:
- 1 Lion Elite Wellness post, reel, or carousel.
- 1 Lion Elite Beauty post, reel, or carousel.
- 1 AlexTheLionLifts post or reel.

Stories and secondary posts may be added when media is available.

## Content record

Each content asset should store:
- brand
- platform
- content_type
- hook
- caption
- CTA
- compliance footer
- media asset IDs/URLs
- scheduled_at
- status
- provider_post_id
- published_url
- failure_reason
- created_at
- published_at

## Publishing modes

### Auto mode
Routine content that matches approved rules and passes validation publishes automatically.

### Review fallback
Content involving new claims, promotions, sensitive topics, regulatory ambiguity, failed validation, or missing media is blocked and moved to a review queue instead of posting.

## Provider architecture

Preferred current provider: Metricool, because Lion Elite social accounts are already being connected there.

LionOS should use the provider API to:
1. Authenticate securely.
2. Map each Lion Elite brand to its correct social profiles.
3. Upload or reference media.
4. Create scheduled posts.
5. Publish at configured times.
6. Reconcile provider IDs and statuses.
7. Pull available performance analytics back into LionOS.

## Idempotency and failures

- Every scheduled post must have an idempotency key.
- Never duplicate a post after an uncertain provider response.
- Retry transient failures with bounded retries.
- Persist the payload and failure reason.
- Alert the executive dashboard when publishing fails.

## Analytics feedback loop

Capture available metrics:
- views/impressions
- reach
- likes
- comments
- shares
- saves
- clicks
- profile visits
- leads/conversations attributed
- revenue attributed when measurable

Use this data to improve future hooks, topics, CTAs, formats, and posting times.

## Configuration

Store all credentials in deployment secrets, never GitHub.

Expected configuration categories:
- SOCIAL_PUBLISHING_ENABLED
- SOCIAL_PROVIDER
- SOCIAL_PROVIDER_API_TOKEN
- SOCIAL_PROVIDER_ACCOUNT_ID
- LEW_SOCIAL_PROFILE_IDS
- LEB_SOCIAL_PROFILE_IDS
- ALEX_SOCIAL_PROFILE_IDS

`SOCIAL_PUBLISHING_ENABLED` must remain false until provider authentication, account mapping, media upload, scheduling, publishing, reconciliation, and failure handling are tested successfully.

## Definition of done

LionOS automatically creates daily content for all three brands, blocks non-compliant Lion Elite Wellness content, schedules valid content through the authorized provider, publishes without daily manual intervention, records post URLs and statuses, retries or flags failures, and reports available engagement and conversion data back into the executive brief.
