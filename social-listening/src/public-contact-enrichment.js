'use strict';

// Public-contact enrichment for Bluesky leads.
//
// This module only follows URLs a prospect voluntarily publishes on their
// Bluesky profile and extracts contact details that are already publicly
// visible on those pages. It does not query data brokers, infer hidden email
// addresses, probe SMTP servers, bypass robots/access controls, or mark a lead
// as consented for outreach.

const { URL } = require('node:url');
const dns = require('node:dns').promises;
const net = require('node:net');

const BSKY_PROFILE_ENDPOINT = 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PROFILE_URLS = 3;
const MAX_PAGE_BYTES = 512 * 1024;

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&#64;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&nbsp;/gi, ' ');
}

function normalizeUrl(raw) {
  if (!raw) return null;
  const value = decodeHtml(String(raw).trim()).replace(/[),.;!?]+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function extractUrls(text = '') {
  const decoded = decodeHtml(text);
  const matches = decoded.match(/https?:\/\/[^\s<>"']+|(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi) || [];
  return uniq(matches.map(normalizeUrl)).slice(0, MAX_PROFILE_URLS);
}

function deobfuscateEmailText(text = '') {
  return decodeHtml(text)
    .replace(/\s*(?:\[at\]|\(at\)|\sat\s)\s*/gi, '@')
    .replace(/\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*/gi, '.');
}

function extractEmails(html = '') {
  const text = deobfuscateEmailText(html);
  const mailtos = [...text.matchAll(/mailto:([^?"'<>\s]+)/gi)].map(match => match[1]);
  const plain = text.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return uniq([...mailtos, ...plain]
    .map(value => value.trim().toLowerCase())
    .filter(value => value.length <= 254 && !/\.(png|jpe?g|gif|webp|svg)$/i.test(value)));
}

function extractPhones(html = '') {
  const decoded = decodeHtml(html);
  const tels = [...decoded.matchAll(/tel:([^"'<>\s]+)/gi)].map(match => match[1]);
  const plain = decoded.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  return uniq([...tels, ...plain].map(value => {
    const raw = value.trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return raw.startsWith('+') && digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }));
}

function isPrivateIp(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  return true;
}

async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('UNSUPPORTED_PROTOCOL');
  if (url.username || url.password) throw new Error('URL_CREDENTIALS_NOT_ALLOWED');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('PRIVATE_HOST_NOT_ALLOWED');
  if (net.isIP(hostname) && isPrivateIp(hostname)) throw new Error('PRIVATE_HOST_NOT_ALLOWED');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) throw new Error('PRIVATE_HOST_NOT_ALLOWED');
  return url;
}

async function fetchText(rawUrl, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const safeUrl = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(safeUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'LionEliteOS-PublicContactEnrichment/1.0 (+https://lionelitebeauty.com)'
      }
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error('UNSUPPORTED_CONTENT_TYPE');
    }
    const text = await response.text();
    return text.slice(0, MAX_PAGE_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBlueskyProfile(actor, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${BSKY_PROFILE_ENDPOINT}?actor=${encodeURIComponent(actor)}`;
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`BLUESKY_PROFILE_HTTP_${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function enrichPublicContact(actor, options = {}) {
  const profile = await fetchBlueskyProfile(actor, options);
  const description = profile.description || '';
  const profileUrls = extractUrls(description);
  const directEmails = extractEmails(description);
  const directPhones = extractPhones(description);
  const sources = [];
  const emails = [...directEmails];
  const phones = [...directPhones];

  if (directEmails.length || directPhones.length) {
    sources.push({
      url: `https://bsky.app/profile/${encodeURIComponent(profile.handle || actor)}`,
      emails: directEmails,
      phones: directPhones,
      sourceType: 'bluesky_profile'
    });
  }

  for (const url of profileUrls.slice(0, MAX_PROFILE_URLS)) {
    try {
      const html = await fetchText(url, options);
      const pageEmails = extractEmails(html);
      const pagePhones = extractPhones(html);
      if (pageEmails.length || pagePhones.length) {
        emails.push(...pageEmails);
        phones.push(...pagePhones);
        sources.push({ url, emails: pageEmails, phones: pagePhones, sourceType: 'public_profile_link' });
      }
    } catch (error) {
      sources.push({ url, error: error.message, sourceType: 'public_profile_link' });
    }
  }

  return {
    actor,
    did: profile.did || actor,
    handle: profile.handle || null,
    displayName: profile.displayName || null,
    profileUrl: `https://bsky.app/profile/${encodeURIComponent(profile.handle || actor)}`,
    websiteUrls: profileUrls,
    publicEmails: uniq(emails),
    publicPhones: uniq(phones),
    sources,
    enrichmentPolicy: 'public_profile_and_linked_business_pages_only',
    outreachConsent: false,
    outreachEligible: false,
    enrichedAt: new Date().toISOString()
  };
}

module.exports = {
  extractUrls,
  extractEmails,
  extractPhones,
  normalizeUrl,
  isPrivateIp,
  assertPublicUrl,
  fetchBlueskyProfile,
  fetchText,
  enrichPublicContact
};
