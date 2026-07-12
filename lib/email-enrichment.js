'use strict';

const { URL } = require('node:url');

const CONTACT_PATH_HINTS = [
  '/contact', '/contact-us', '/about', '/about-us', '/team', '/staff', '/partnerships'
];

const ROLE_INBOXES = new Set([
  'info', 'hello', 'contact', 'support', 'team', 'office', 'admin', 'sales',
  'partnerships', 'partners', 'marketing', 'membership', 'memberships', 'connect'
]);

function normalizeDomain(value = '') {
  const raw = String(value).trim().toLowerCase();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function normalizeEmail(value = '') {
  return String(value).trim().toLowerCase().replace(/[),.;:]+$/, '');
}

function emailDomain(email = '') {
  return normalizeEmail(email).split('@')[1] || '';
}

function isValidEmail(email = '') {
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(email);
}

function extractEmails(html = '') {
  const decoded = String(html)
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.');
  const matches = decoded.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return [...new Set(matches.map(normalizeEmail).filter(isValidEmail))];
}

function classifyEmail(email, businessDomain) {
  const normalized = normalizeEmail(email);
  const local = normalized.split('@')[0] || '';
  const domain = emailDomain(normalized);
  const domainMatch = domain === businessDomain || domain.endsWith(`.${businessDomain}`);
  const roleInbox = ROLE_INBOXES.has(local);
  const likelyPersonal = !roleInbox && /^[a-z]+([._-][a-z]+)+$/i.test(local);

  return {
    email: normalized,
    domain,
    domainMatch,
    roleInbox,
    likelyPersonal,
    eligible: domainMatch && (roleInbox || !likelyPersonal)
  };
}

function scoreCandidate(candidate) {
  let score = 0;
  if (candidate.domainMatch) score += 55;
  if (candidate.roleInbox) score += 25;
  if (candidate.sourceType === 'mailto') score += 10;
  if (candidate.contactPage) score += 10;
  if (candidate.likelyPersonal) score -= 20;
  return Math.max(0, Math.min(100, score));
}

function discoverContactLinks(html, baseUrl) {
  const links = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(String(html)))) {
    try {
      const url = new URL(match[1], baseUrl);
      const base = new URL(baseUrl);
      if (url.hostname !== base.hostname) continue;
      if (CONTACT_PATH_HINTS.some(hint => url.pathname.toLowerCase().includes(hint))) {
        links.push(url.toString().split('#')[0]);
      }
    } catch {
      // Ignore malformed links.
    }
  }
  return [...new Set(links)].slice(0, 6);
}

async function fetchPage(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': options.userAgent || 'LionEliteOS/1.0 business-contact-verification',
        accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) return { ok: false, status: response.status, url: response.url || url, html: '' };
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return { ok: false, status: 415, url: response.url || url, html: '' };
    }
    return { ok: true, status: response.status, url: response.url || url, html: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function candidatesFromPage(page, businessDomain) {
  const mailtoMatches = [...String(page.html).matchAll(/mailto:([^?"'\s>]+)/gi)].map(match => normalizeEmail(decodeURIComponent(match[1])));
  const all = extractEmails(page.html);
  const mailtoSet = new Set(mailtoMatches);
  const contactPage = CONTACT_PATH_HINTS.some(hint => new URL(page.url).pathname.toLowerCase().includes(hint));

  return all.map(email => {
    const classified = classifyEmail(email, businessDomain);
    const candidate = {
      ...classified,
      sourceUrl: page.url,
      sourceType: mailtoSet.has(email) ? 'mailto' : 'page_text',
      contactPage,
      capturedAt: new Date().toISOString()
    };
    return { ...candidate, confidence: scoreCandidate(candidate) };
  });
}

async function enrichBusinessEmail(business, options = {}) {
  const website = business.website || business.url || business.domain;
  if (!website) {
    return { status: 'blocked', reason: 'MISSING_OFFICIAL_WEBSITE', candidates: [] };
  }

  const rootUrl = new URL(String(website).includes('://') ? website : `https://${website}`).toString();
  const businessDomain = normalizeDomain(rootUrl);
  const pages = [];
  const root = await fetchPage(rootUrl, options);
  if (!root.ok) {
    return { status: 'blocked', reason: 'OFFICIAL_WEBSITE_UNAVAILABLE', businessDomain, candidates: [], pagesChecked: [root] };
  }
  pages.push(root);

  const discovered = discoverContactLinks(root.html, root.url);
  const fallback = CONTACT_PATH_HINTS.map(path => new URL(path, root.url).toString());
  const pageUrls = [...new Set([...discovered, ...fallback])].slice(0, options.maxPages || 6);

  for (const url of pageUrls) {
    if (url === root.url) continue;
    try {
      const page = await fetchPage(url, options);
      if (page.ok) pages.push(page);
    } catch {
      // A failed secondary page must not fail the entire enrichment run.
    }
  }

  const candidates = pages
    .flatMap(page => candidatesFromPage(page, businessDomain))
    .filter(candidate => candidate.eligible)
    .sort((a, b) => b.confidence - a.confidence);

  const unique = [...new Map(candidates.map(item => [item.email, item])).values()];
  const selected = unique.find(item => item.confidence >= (options.minimumConfidence || 80));

  if (!selected) {
    return {
      status: 'blocked',
      reason: 'NO_VERIFIED_PUBLIC_BUSINESS_EMAIL',
      businessDomain,
      candidates: unique,
      pagesChecked: pages.map(page => ({ url: page.url, status: page.status }))
    };
  }

  return {
    status: 'verified',
    businessDomain,
    email: selected.email,
    confidence: selected.confidence,
    evidence: {
      sourceUrl: selected.sourceUrl,
      sourceType: selected.sourceType,
      capturedAt: selected.capturedAt,
      domainMatch: selected.domainMatch,
      roleInbox: selected.roleInbox
    },
    candidates: unique,
    pagesChecked: pages.map(page => ({ url: page.url, status: page.status }))
  };
}

async function enrichBatch(businesses = [], options = {}) {
  const results = [];
  for (const business of businesses.slice(0, options.maxBatchSize || 25)) {
    try {
      results.push({ business, result: await enrichBusinessEmail(business, options) });
    } catch (error) {
      results.push({
        business,
        result: { status: 'blocked', reason: 'ENRICHMENT_ERROR', message: error.message, candidates: [] }
      });
    }
  }
  return {
    total: results.length,
    verified: results.filter(item => item.result.status === 'verified').length,
    blocked: results.filter(item => item.result.status !== 'verified').length,
    results
  };
}

module.exports = {
  normalizeDomain,
  normalizeEmail,
  extractEmails,
  classifyEmail,
  discoverContactLinks,
  enrichBusinessEmail,
  enrichBatch
};
