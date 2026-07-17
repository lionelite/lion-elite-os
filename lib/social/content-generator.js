'use strict';

// Deterministic, template-based daily content generation (Issue #48,
// Phase 1). Like lib/email-generation.js, this module needs no AI to
// produce complete output — the optional AI provider (see
// lib/social/ai-provider.js) can rewrite captions, but every AI result is
// compliance-validated and falls back to these templates on any failure,
// so the daily workflow never depends on an external API being up.

const { getBrandProfile } = require('./brand-profiles');
const { selectTopics } = require('./topic-rotation');

const X_CHAR_LIMIT = 280;

// Local posting times (America/New_York) written into the Metricool CSV.
// Brands are offset so the two calendars never collide on a time slot.
const POSTING_TIMES = Object.freeze({
  wellness: { feed: '09:00', reel: '12:30', 'story-1': '15:00', 'story-2': '19:00' },
  beauty: { feed: '10:00', reel: '13:30', 'story-1': '16:00', 'story-2': '20:00' }
});

const MEDIA_SPECS = Object.freeze({
  feed: { format: 'feed', dimensions: '1080x1350', aspectRatio: '4:5' },
  vertical: { format: 'vertical', dimensions: '1080x1920', aspectRatio: '9:16' }
});

function dayNumber(dateStr) {
  const parsed = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date: ${dateStr} (expected YYYY-MM-DD)`);
  }
  return Math.floor(parsed / (24 * 60 * 60 * 1000));
}

function pickCta(profile, dateStr, slotOffset) {
  const ctas = profile.ctaRotation;
  return ctas[(dayNumber(dateStr) + slotOffset) % ctas.length];
}

function withDisclaimer(profile, text) {
  return profile.disclaimer ? `${text}\n\n${profile.disclaimer}` : text;
}

function hashtagBlock(profile) {
  return profile.hashtags.join(' ');
}

function bulletList(points, marker = '•') {
  return points.map((p) => `${marker} ${p}`).join('\n');
}

function numberedList(points) {
  return points.map((p, i) => `${i + 1}. ${p}`).join('\n');
}

function truncateTo(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function buildXText(profile, topic, cta) {
  const parts = [topic.hook, cta.text];
  if (profile.disclaimer) parts.push(profile.disclaimer);
  let text = parts.join('\n\n');
  if (text.length > X_CHAR_LIMIT) {
    // Drop the CTA before ever touching the disclaimer.
    const reduced = [topic.hook];
    if (profile.disclaimer) reduced.push(profile.disclaimer);
    text = reduced.join('\n\n');
  }
  if (text.length > X_CHAR_LIMIT) {
    const reserved = profile.disclaimer ? profile.disclaimer.length + 2 : 0;
    text = `${truncateTo(topic.hook, X_CHAR_LIMIT - reserved)}${profile.disclaimer ? `\n\n${profile.disclaimer}` : ''}`;
  }
  return text;
}

function buildMediaSpec(profile, topic, slot) {
  const base = slot === 'feed' ? MEDIA_SPECS.feed : MEDIA_SPECS.vertical;
  const surface = slot === 'feed'
    ? 'Vertical 4:5 feed image, 1080x1350 px'
    : slot === 'reel'
      ? 'Vertical 9:16 Reel/TikTok cover, 1080x1920 px'
      : 'Vertical 9:16 Story frame, 1080x1920 px';
  return {
    ...base,
    prompt:
      `${topic.visual}. ${profile.name} aesthetic: premium, minimal, ` +
      'earth tones and black-and-white accents, natural light, no text overlay. ' +
      `${surface}.`
  };
}

function buildFeedPiece(profile, topic, dateStr) {
  const cta = pickCta(profile, dateStr, 0);
  const intro = profile.complianceMode === 'research-only'
    ? `${topic.title} — today's research education note from ${profile.name}.`
    : `${topic.title} — today's standard from ${profile.name}.`;

  const longCaption = withDisclaimer(
    profile,
    `${topic.hook}\n\n${intro}\n\n${bulletList(topic.points)}\n\n${cta.text}`
  );

  return {
    id: `${dateStr}-${profile.key}-feed`,
    brand: profile.key,
    date: dateStr,
    slot: 'feed',
    type: profile.feedType,
    topic: { slug: topic.slug, title: topic.title },
    cta: cta.key,
    platforms: {
      instagram: { text: `${longCaption}\n\n${hashtagBlock(profile)}` },
      facebook: { text: longCaption },
      linkedin: {
        text: withDisclaimer(
          profile,
          `${topic.title}\n\n${topic.hook}\n\n${bulletList(topic.points, '—')}\n\n${cta.text}`
        )
      },
      x: { text: buildXText(profile, topic, cta) }
    },
    media: buildMediaSpec(profile, topic, 'feed'),
    schedule: { date: dateStr, time: POSTING_TIMES[profile.key].feed }
  };
}

function buildReelPiece(profile, topic, dateStr) {
  const cta = pickCta(profile, dateStr, 1);
  const script = withDisclaimer(
    profile,
    `HOOK (0-3s, on camera or bold text): ${topic.hook}\n\n` +
    `BODY (talking points, one per cut):\n${numberedList(topic.points)}\n\n` +
    `CTA (final 3s): ${cta.text}` +
    (profile.disclaimer ? '\n\nON-SCREEN DISCLAIMER (visible full duration): see below.' : '')
  );

  return {
    id: `${dateStr}-${profile.key}-reel`,
    brand: profile.key,
    date: dateStr,
    slot: 'reel',
    type: 'reel_script',
    topic: { slug: topic.slug, title: topic.title },
    cta: cta.key,
    platforms: {
      instagram: {
        text: withDisclaimer(profile, `${topic.hook}\n\n${cta.text}`) + `\n\n${hashtagBlock(profile)}`
      },
      tiktok: { text: script }
    },
    media: buildMediaSpec(profile, topic, 'reel'),
    schedule: { date: dateStr, time: POSTING_TIMES[profile.key].reel }
  };
}

function buildStoryPieces(profile, topic, dateStr) {
  const teaserCta = pickCta(profile, dateStr, 2);
  const engageCta = pickCta(profile, dateStr, 3 % profile.ctaRotation.length);

  const teaser = {
    id: `${dateStr}-${profile.key}-story-1`,
    brand: profile.key,
    date: dateStr,
    slot: 'story-1',
    type: 'story',
    topic: { slug: topic.slug, title: topic.title },
    cta: teaserCta.key,
    platforms: {
      instagram: {
        text: withDisclaimer(
          profile,
          `${topic.hook}\n\n${topic.points[0]}\n\nNew post is live — full breakdown on the feed.`
        )
      }
    },
    media: buildMediaSpec(profile, topic, 'story-1'),
    schedule: { date: dateStr, time: POSTING_TIMES[profile.key]['story-1'] }
  };

  const question = profile.complianceMode === 'research-only'
    ? `Question sticker: What research-quality topic should we break down next?`
    : `Question sticker: What is the one habit you refuse to skip this week?`;

  const engagement = {
    id: `${dateStr}-${profile.key}-story-2`,
    brand: profile.key,
    date: dateStr,
    slot: 'story-2',
    type: 'story',
    topic: { slug: topic.slug, title: topic.title },
    cta: engageCta.key,
    platforms: {
      instagram: {
        text: withDisclaimer(profile, `${question}\n\n${engageCta.text}`)
      }
    },
    media: buildMediaSpec(profile, topic, 'story-2'),
    schedule: { date: dateStr, time: POSTING_TIMES[profile.key]['story-2'] }
  };

  return [teaser, engagement];
}

/**
 * Build the full daily cadence for one brand (Issue #48): 1 feed post,
 * 1 Reel/TikTok script, and 2 Stories. The feed and reel use two distinct
 * topics chosen by the seven-day rotation; the stories support the feed
 * topic (teaser + engagement) rather than introducing a third.
 */
function generateDailyPlan({ brand, date, history = [] }) {
  const profile = getBrandProfile(brand);
  const [feedTopic, reelTopic] = selectTopics({ profile, history, date, count: 2 });

  return {
    brand: profile.key,
    brandName: profile.name,
    date,
    pieces: [
      buildFeedPiece(profile, feedTopic, date),
      buildReelPiece(profile, reelTopic, date),
      ...buildStoryPieces(profile, feedTopic, date)
    ]
  };
}

module.exports = {
  X_CHAR_LIMIT,
  POSTING_TIMES,
  generateDailyPlan,
  buildXText
};
