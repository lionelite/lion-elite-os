'use strict';

// Pull real, public posts from Bluesky's unauthenticated AppView search and
// turn the ones that match an audience profile into lead records.
//
// Why search and not the firehose: the Jetstream listener only sees posts
// made while it happens to be connected, so a cold start sees nothing and a
// restart loses the backlog. Search reaches posts that already exist, which
// is what "show me leads today" actually needs.
//
// Read-only by construction. This module fetches public posts and writes
// records to a file. It has no send path, follows nobody, likes nothing, and
// never touches a post it read. Engagement stays a manual human action.

const { classifyPost } = require('../../social-listening/src/classifier');
const { AUDIENCE_PROFILES } = require('../../social-listening/src/audience-profiles');

const SEARCH_ENDPOINT = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';

// Search phrases per audience. These are deliberately narrower than the
// classifier's subject terms: search decides what we PAY attention to,
// the classifier decides what actually qualifies. A loose query costs one
// HTTP call; a loose classifier would cost a bad lead.
const SEARCH_QUERIES = Object.freeze({
  'coach-scaling': [
    'looking for a coaching platform',
    'what platform do you use for online coaching',
    'starting my online coaching business',
    'just got certified personal trainer',
    'tired of spreadsheets for my clients',
    'how do I get my first coaching client',
    'scale my personal training business',
    'app for my training clients'
  ],
  'personal-training': [
    'looking for a personal trainer',
    'need a fitness coach',
    'looking for an online coach',
    'need a workout plan',
    'want to get back in the gym',
    'need an accountability coach'
  ],
  'research-peptides': [
    'peptide vendor recommendations',
    'where to source research peptides',
    'reputable peptide supplier',
    'looking for BPC-157 source',
    'certificate of analysis peptides'
  ],
  'business-scaling': [
    'how do I get more clients',
    'need to automate my business',
    'looking for a CRM for my small business',
    'trying to scale my business'
  ]
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** at://did:plc:xxx/app.bsky.feed.post/<rkey> -> the rkey */
function rkeyFromUri(uri = '') {
  const parts = String(uri).split('/');
  return parts[parts.length - 1] || '';
}

function postUrl(post) {
  const handle = post?.author?.handle;
  const rkey = rkeyFromUri(post?.uri);
  if (!handle || !rkey) return null;
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

/**
 * One page of public search results. No credential is sent — this endpoint
 * is the same one bsky.app uses for logged-out search.
 */
async function searchPosts({ query, limit = 25, fetchImpl = fetch, endpoint = SEARCH_ENDPOINT } = {}) {
  const url = `${endpoint}?q=${encodeURIComponent(query)}&limit=${Math.min(100, Math.max(1, limit))}&sort=latest`;
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'lion-elite-os lead harvest (read-only)' }
  });
  if (!response.ok) {
    throw new Error(`Bluesky search failed for "${query}": HTTP ${response.status}`);
  }
  const body = await response.json();
  return Array.isArray(body?.posts) ? body.posts : [];
}

/**
 * Turn one matched post into a lead record.
 * Keeps the evidence (which terms fired, the post link) so a human can see
 * why this person is here before deciding to say anything to them.
 */
function toLead(post, match, query) {
  return {
    id: post.uri,
    source: 'bluesky-search',
    capturedAt: new Date().toISOString(),
    audience: match.audience,
    brand: match.brand,
    lane: AUDIENCE_PROFILES[match.audience]?.label || match.audience,
    score: match.score,
    name: post.author?.displayName || post.author?.handle || null,
    handle: post.author?.handle || null,
    did: post.author?.did || null,
    profileUrl: post.author?.handle ? `https://bsky.app/profile/${post.author.handle}` : null,
    postUrl: postUrl(post),
    postedAt: post.record?.createdAt || post.indexedAt || null,
    text: (post.record?.text || '').slice(0, 600),
    matchedQuery: query,
    matchedTerms: match.matched,
    suggestedOpener: match.suggestedOpener,
    // Contact details are not scraped. A Bluesky handle IS the contact
    // channel here; email/phone for these people would have to be given,
    // not taken, which is what the opt-in page is for.
    contactChannel: 'bluesky',
    email: null,
    phone: null
  };
}

/**
 * Run every query for the requested audiences and return deduped leads.
 *
 * @param {object}   opts
 * @param {string[]} opts.audiences  audience keys to harvest (default: all)
 * @param {Function} opts.fetchImpl  injected for tests
 * @param {number}   opts.perQuery   results requested per search
 * @param {number}   opts.delayMs    politeness gap between searches
 */
async function harvestBluesky({
  audiences,
  fetchImpl = fetch,
  perQuery = 25,
  delayMs = 700,
  queries = SEARCH_QUERIES,
  logger = console
} = {}) {
  const keys = audiences && audiences.length ? audiences : Object.keys(queries);
  const leads = [];
  const seen = new Set();
  const summary = { searched: 0, postsSeen: 0, matched: 0, skippedDoNotEngage: 0, duplicates: 0, errors: [] };

  for (const audience of keys) {
    const audienceQueries = queries[audience] || [];
    for (const query of audienceQueries) {
      let posts = [];
      try {
        posts = await searchPosts({ query, limit: perQuery, fetchImpl });
        summary.searched += 1;
      } catch (error) {
        summary.errors.push(`${audience}: ${error.message}`);
        logger.warn?.(`[harvest] ${error.message}`);
        continue;
      }

      summary.postsSeen += posts.length;

      for (const post of posts) {
        const text = post?.record?.text;
        if (!text) continue;

        // Classify against this audience only. A post found by a
        // coach-scaling query still has to qualify as coach-scaling.
        const { matches } = classifyPost(text, { audiences: [audience] });
        const match = matches[0];
        if (!match) continue;

        // RUO compliance and the peer/prospect split both live in the
        // profiles. If the profile says do-not-engage, the lead is dropped
        // here rather than stored for someone to find later.
        if (match.doNotEngage) {
          summary.skippedDoNotEngage += 1;
          continue;
        }

        const key = `${audience}:${post.uri}`;
        if (seen.has(key)) {
          summary.duplicates += 1;
          continue;
        }
        seen.add(key);

        leads.push(toLead(post, match, query));
        summary.matched += 1;
      }

      if (delayMs) await sleep(delayMs);
    }
  }

  leads.sort((a, b) => b.score - a.score || String(b.postedAt).localeCompare(String(a.postedAt)));
  return { leads, summary };
}

module.exports = { SEARCH_ENDPOINT, SEARCH_QUERIES, searchPosts, harvestBluesky, toLead, rkeyFromUri, postUrl };
