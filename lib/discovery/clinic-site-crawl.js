'use strict';

/**
 * Read a clinic's own website for the contact details it publishes.
 *
 * Crawls the home page plus the contact / about / team pages (linked from the
 * home page where possible, else the conventional paths) and returns:
 *
 *   email   a BUSINESS address on the clinic's own domain. Personal webmail
 *           (gmail, yahoo, …) is refused and counted, as is anything that reads
 *           as one named person's mailbox (first.last@) — the same rule
 *           lib/email-enrichment.js and the 16-check engine apply.
 *   phone   the business phone the site publishes (tel: links first).
 *   leader  the owner / founder / medical director the site itself names,
 *           with the page it came from. Recorded as evidence on the business,
 *           never used as a mailbox and never guessed into an address.
 *   signals service terms on the site (hormone, IV, weight loss, …), recorded
 *           as evidence. They do not change the targeting tier: the send gate
 *           in lib/outreach/clinic-qualification.js is unchanged.
 *
 * One page at a time per site, short timeouts, an identifying User-Agent. These
 * are small businesses' servers.
 */

const { URL } = require('node:url');
const { normalizeDomain, extractEmails, classifyEmail } = require('../email-enrichment');

const PERSONAL_WEBMAIL = Object.freeze(new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net',
  'protonmail.com', 'proton.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'cox.net', 'charter.net',
  'bellsouth.net', 'earthlink.net', 'hotmail.ca', 'yahoo.ca', 'shaw.ca', 'rogers.com', 'sympatico.ca', 'videotron.ca',
  'hotmail.com.mx', 'yahoo.com.mx', 'prodigy.net.mx', 'outlook.es', 'hotmail.es', 'qq.com', '163.com'
]));

// Shared inboxes a clinic actually answers, beyond the generic list in
// lib/email-enrichment.js. A role inbox is preferred over any other address.
const CLINIC_ROLE_INBOXES = Object.freeze(new Set([
  'info', 'hello', 'contact', 'contactus', 'office', 'admin', 'team', 'support', 'help', 'mail', 'email', 'inquiries',
  'inquiry', 'enquiries', 'questions', 'frontdesk', 'front.desk', 'reception', 'appointments', 'appointment', 'booking',
  'bookings', 'book', 'schedule', 'scheduling', 'concierge', 'care', 'patientcare', 'patients', 'newpatients',
  'clinic', 'spa', 'medspa', 'wellness', 'manager', 'practice', 'practicemanager', 'partnerships', 'marketing', 'sales'
]));

// Never business contacts, wherever they appear.
const JUNK_LOCAL = /^(no-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|webmaster|wordpress|example|test|user|name|your|email@)/i;
const JUNK_DOMAIN = /(sentry|wixpress|example\.com|domain\.com|godaddy|squarespace|wix\.com|email\.com$|yourdomain|sentry-next)/i;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;

const LINK_HINT = /contact|about|team|staff|provider|our-?doctors|physician|meet|leadership|founder|who-we-are|location/i;
const FALLBACK_PATHS = Object.freeze(['/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team']);

const SERVICE_SIGNALS = Object.freeze([
  ['hormone', /hormone|\bhrt\b|\btrt\b|testosterone|bhrt/i],
  ['weight loss', /weight[\s-]?loss|semaglutide|tirzepatide|glp-?1|medical weight/i],
  ['peptides', /peptide/i],
  ['iv therapy', /\biv\s+(therapy|drip|hydration|infusion)|nad\+?\s|vitamin\s+infusion/i],
  ['longevity', /longevity|anti[\s-]?aging|healthspan/i],
  ['aesthetics', /botox|dysport|dermal\s+filler|injectables|aesthetic/i],
  ['regenerative', /regenerative|\bprp\b|stem\s+cell|exosome/i],
  ['functional medicine', /functional\s+medicine|integrative|naturopath/i]
]);

const LEADER_ROLES = 'Medical Director|Founder|Co-Founder|Owner|Co-Owner|Clinical Director|Practice Owner|Chief Medical Officer|CEO';
const CREDENTIALS = 'MD|M\\.D\\.|DO|D\\.O\\.|NP|NP-C|FNP|FNP-C|APRN|PA-C|DNP|ND|RN|BSN|MSN|DC|PhD';
const NAME = "[A-Z][a-z'’-]+(?:\\s+[A-Z]\\.)?(?:\\s+[A-Z][a-zA-Z'’-]+){1,2}";
const LEADER_PATTERNS = Object.freeze([
  // "Medical Director: Dr. Jane Smith, MD" / "Founder – Jane Smith"
  new RegExp(`\\b(${LEADER_ROLES})\\b\\s*(?:[:,|–—-]|is|&)?\\s*(?:is\\s+)?(?:Dr\\.?\\s+)?(${NAME})(?:,?\\s+(${CREDENTIALS})\\b)?`),
  // "Dr. Jane Smith, MD, Medical Director" / "Jane Smith, NP – Owner"
  new RegExp(`(?:Dr\\.?\\s+)?(${NAME})(?:,?\\s+(${CREDENTIALS})\\b)?\\s*(?:[,|–—-]|is\\s+(?:the|our))\\s*(?:the\\s+|our\\s+)?(${LEADER_ROLES})\\b`)
]);
const NOT_A_NAME = /\b(Our|The|Meet|Your|Medical|Spa|Clinic|Wellness|Center|Centre|About|Contact|Team|Services|Book|Call|Learn|More|Read|Health|Aesthetics|Institute|Group|Studio|Lounge|Bar|Day|Today|Now|Free|New|Home|Privacy|Policy|Rights|Reserved|Director|Founder|Owner|Office|Hours|Message|Location|Locations)\b/;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function decodeCloudflareEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return '';
  }
}

function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every address a page publishes: text, mailto:, and Cloudflare-obfuscated. */
function emailsOnPage(html) {
  const found = new Set(extractEmails(html));
  for (const m of String(html).matchAll(/mailto:([^?"'\s>]+)/gi)) {
    try { found.add(decodeURIComponent(m[1]).trim().toLowerCase()); } catch { /* malformed */ }
  }
  for (const m of String(html).matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) {
    const decoded = decodeCloudflareEmail(m[1]).trim().toLowerCase();
    if (decoded.includes('@')) found.add(decoded);
  }
  return [...found].filter(e => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e) && !ASSET_SUFFIX.test(e));
}

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  const bare = digits.replace(/^\+/, '');
  if (/^1?\d{10}$/.test(bare)) {
    const ten = bare.length === 11 ? bare.slice(1) : bare;
    if (/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return `+1${ten}`;
  }
  if (/^52\d{10}$/.test(bare)) return `+${bare}`;
  return null;
}

function phonesOnPage(html) {
  const out = [];
  for (const m of String(html).matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const p = normalisePhone(decodeURIComponent(m[1]));
    if (p) out.push(p);
  }
  if (!out.length) {
    for (const m of textOf(html).matchAll(/(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}\b/g)) {
      const p = normalisePhone(m[0]);
      if (p) out.push(p);
    }
  }
  return [...new Set(out)];
}

function leaderOnPage(html) {
  const text = textOf(html);
  for (const pattern of LEADER_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    // Pattern 1: role, name, credential. Pattern 2: name, credential, role.
    const [role, name, credential] = pattern === LEADER_PATTERNS[0] ? [m[1], m[2], m[3]] : [m[3], m[1], m[2]];
    const clean = String(name || '').trim();
    if (!clean || NOT_A_NAME.test(clean) || clean.split(/\s+/).length > 4) continue;
    return { name: clean, role: role.trim(), credential: credential || null };
  }
  return null;
}

function signalsOnPage(html) {
  const text = textOf(html);
  return SERVICE_SIGNALS.filter(([, re]) => re.test(text)).map(([label]) => label);
}

function sameOrg(a, b) {
  return Boolean(a && b) && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

/**
 * Judge one address. Returns { ok, reason, score }.
 * Only the clinic's own domain is a business contact here; that is also what
 * the identity check in clinic-qualification requires before anything is sent.
 */
function judgeEmail(email, domains) {
  const address = String(email || '').trim().toLowerCase();
  const [local, domain] = address.split('@');
  if (!local || !domain) return { ok: false, reason: 'malformed' };
  if (PERSONAL_WEBMAIL.has(domain)) return { ok: false, reason: 'personal_webmail' };
  if (JUNK_LOCAL.test(local) || JUNK_DOMAIN.test(domain)) return { ok: false, reason: 'junk' };
  if (!domains.some(d => sameOrg(domain, d))) return { ok: false, reason: 'other_domain' };
  const role = CLINIC_ROLE_INBOXES.has(local) || CLINIC_ROLE_INBOXES.has(local.replace(/[0-9]+$/, ''));
  const personal = !role && classifyEmail(address, domain).likelyPersonal;
  if (personal) return { ok: false, reason: 'named_person' };
  return { ok: true, score: role ? 2 : 1 };
}

async function fetchHtml(url, { fetchImpl, timeoutMs, userAgent }) {
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' }
  });
  if (!response.ok) return { ok: false, status: response.status, url: response.url || url };
  const type = response.headers?.get?.('content-type') || '';
  if (type && !/text\/html|application\/xhtml/.test(type)) return { ok: false, status: 415, url: response.url || url };
  const html = (await response.text()).slice(0, 1_500_000);
  return { ok: true, status: response.status, url: response.url || url, html };
}

function candidatePages(rootHtml, rootUrl) {
  const base = new URL(rootUrl);
  const linked = [];
  for (const m of String(rootHtml).matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(m[1], base);
      if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      if (!LINK_HINT.test(url.pathname) || ASSET_SUFFIX.test(url.pathname)) continue;
      linked.push(`${url.origin}${url.pathname}`);
    } catch { /* malformed */ }
  }
  // Contact pages first: the address is most often there.
  linked.sort((a, b) => Number(/contact/i.test(b)) - Number(/contact/i.test(a)));
  const fallback = FALLBACK_PATHS.map(p => new URL(p, base.origin).toString());
  return [...new Set([...linked, ...fallback])].filter(u => u.replace(/\/$/, '') !== rootUrl.replace(/\/$/, ''));
}

/**
 * @returns {{
 *   ok, website, domain, email, emailSource, phone, phoneSource, leader, signals,
 *   refused: { personal_webmail, named_person, other_domain, junk }, pagesChecked, error
 * }}
 */
async function crawlClinicSite({
  website,
  fetchImpl = fetch,
  timeoutMs = 10000,
  maxPages = 5,
  pageDelayMs = 300,
  userAgent = 'LionEliteOS/2.0 (business contact discovery)',
  sleepImpl = wait
} = {}) {
  const result = { ok: false, website, domain: normalizeDomain(website), email: null, emailSource: null, phone: null, phoneSource: null,
    leader: null, signals: [], refused: {}, pagesChecked: 0, error: null };
  let root;
  try {
    root = await fetchHtml(website, { fetchImpl, timeoutMs, userAgent });
  } catch (error) {
    result.error = error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code || error.message || 'fetch failed');
    return result;
  }
  result.pagesChecked = 1;
  if (!root.ok) { result.error = `HTTP ${root.status}`; return result; }
  result.ok = true;

  // A redirect to another domain makes that the clinic's real site.
  const finalDomain = normalizeDomain(root.url);
  const domains = [...new Set([result.domain, finalDomain].filter(Boolean))];
  if (finalDomain && finalDomain !== result.domain) {
    result.website = new URL(root.url).origin + '/';
    result.domain = finalDomain;
  }

  const pages = [root];
  for (const url of candidatePages(root.html, root.url).slice(0, maxPages - 1)) {
    if (pageDelayMs) await sleepImpl(pageDelayMs);
    try {
      const page = await fetchHtml(url, { fetchImpl, timeoutMs, userAgent });
      result.pagesChecked += 1;
      if (page.ok) pages.push(page);
    } catch { /* one failed page does not fail the site */ }
    // Stop early once everything wanted is in hand.
    if (pages.some(p => emailsOnPage(p.html).some(e => judgeEmail(e, domains).ok)) && pages.some(p => leaderOnPage(p.html))) break;
  }

  let best = null;
  for (const page of pages) {
    for (const email of emailsOnPage(page.html)) {
      const verdict = judgeEmail(email, domains);
      if (!verdict.ok) { result.refused[verdict.reason] = (result.refused[verdict.reason] || 0) + 1; continue; }
      const score = verdict.score * 10 + (/contact/i.test(page.url) ? 1 : 0);
      if (!best || score > best.score) best = { email, score, url: page.url };
    }
    if (!result.phone) {
      const phone = phonesOnPage(page.html)[0];
      if (phone) { result.phone = phone; result.phoneSource = page.url; }
    }
    if (!result.leader) {
      const leader = leaderOnPage(page.html);
      if (leader) result.leader = { ...leader, sourceUrl: page.url };
    }
    for (const s of signalsOnPage(page.html)) if (!result.signals.includes(s)) result.signals.push(s);
  }
  if (best) { result.email = best.email; result.emailSource = best.url; }
  return result;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
  return results;
}

module.exports = {
  PERSONAL_WEBMAIL,
  CLINIC_ROLE_INBOXES,
  crawlClinicSite,
  judgeEmail,
  emailsOnPage,
  phonesOnPage,
  leaderOnPage,
  signalsOnPage,
  normalisePhone,
  decodeCloudflareEmail,
  candidatePages,
  mapPool
};
