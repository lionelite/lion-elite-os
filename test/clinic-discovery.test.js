'use strict';

// Clinic discovery, offline: the Overpass query and its retry/mirror rotation,
// listing parsing and exclusions, and the website crawl (business e-mail only,
// phone, owner/medical-director name). Network is stubbed throughout.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIRRORS, buildClinicQuery, parseClinicListings, fetchClinicListings, categoryFor
} = require('../lib/discovery/clinic-overpass');
const {
  crawlClinicSite, judgeEmail, leaderOnPage, emailsOnPage, phonesOnPage, normalisePhone, mapPool
} = require('../lib/discovery/clinic-site-crawl');

const quiet = { warn() {}, log() {} };
const area = { label: 'miami-fl', south: 25.70, west: -80.32, north: 25.95, east: -80.12 };

test('query: one metro box, 90 s server budget, every clinic tag, website required', () => {
  const q = buildClinicQuery(area);
  assert.match(q, /\[timeout:90\]\[bbox:25\.7,-80\.32,25\.95,-80\.12\]/);
  assert.match(q, /nwr\["amenity"~"\^\(clinic\|doctors\)\$"\]/);
  assert.match(q, /nwr\["healthcare"\]\[~"\^\(website\|contact:website\)\$"~"\."\]/);
  assert.match(q, /nwr\["beauty"="spa"\]/);
  assert.match(q, /nwr\["shop"="beauty"\]\["name"~"[^"]*med \?spa[^"]*hormone[^"]*weight \?loss[^"]*longevity[^"]*",i\]/);
  // Every member carries the website filter.
  for (const line of q.split('\n').filter(l => l.trim().startsWith('nwr'))) assert.match(line, /website/);
  assert.throws(() => buildClinicQuery({ south: 1, west: 1, north: 4, east: 2 }), /too large/);
});

test('parse: keeps named listings with a site, drops excluded trades, maps categories', () => {
  const { listings, excluded, counts } = parseClinicListings({ elements: [
    { type: 'node', id: 1, lat: 1, lon: 2, tags: { name: 'Glow Longevity', amenity: 'clinic', website: 'glowlongevity.com', phone: '305-555-0100' } },
    { type: 'way', id: 2, center: { lat: 1, lon: 2 }, tags: { name: 'Bay Pharmacy', healthcare: 'pharmacy', website: 'https://baypharm.com' } },
    { type: 'node', id: 3, tags: { name: 'Kids Care', healthcare: 'doctor', 'healthcare:speciality': 'paediatrics', website: 'https://kids.example' } },
    { type: 'node', id: 4, tags: { name: 'Luxe Med Spa', shop: 'beauty', 'contact:website': 'https://luxemedspa.com' } },
    { type: 'node', id: 5, tags: { name: 'No Site Clinic', amenity: 'doctors' } },
    { type: 'node', id: 6, tags: { amenity: 'clinic', website: 'https://anon.example' } },
    { type: 'node', id: 1, tags: { name: 'Glow Longevity', amenity: 'clinic', website: 'glowlongevity.com' } }
  ] });
  assert.deepEqual(listings.map(l => l.name), ['Glow Longevity', 'Luxe Med Spa']);
  assert.equal(listings[0].website, 'https://glowlongevity.com/');
  assert.equal(listings[0].category, 'clinic');
  assert.equal(listings[1].category, 'med-spa');
  assert.equal(listings[0].sourceRef, 'node/1');
  assert.deepEqual(excluded, { 'healthcare=pharmacy': 1, 'speciality=paediatrics': 1 });
  assert.equal(counts.named, 5);
  assert.equal(counts.withWebsite, 4);
  assert.equal(categoryFor({ healthcare: 'alternative' }), 'clinic');
});

test('fetch: rotates mirrors from the metro index, backs off exponentially, honours Retry-After', async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    { ok: false, status: 504, headers: { get: () => null } },
    { ok: false, status: 429, headers: { get: k => (k === 'retry-after' ? '30' : null) } },
    { ok: true, status: 200, json: async () => ({ elements: [{ type: 'node', id: 9, tags: { name: 'Vital IV Lounge', amenity: 'clinic', website: 'https://vitaliv.com' } }] }) }
  ];
  const result = await fetchClinicListings({
    area, rotation: 1, logger: quiet, userAgent: 'UA (ops@example.com)',
    sleepImpl: async ms => { sleeps.push(ms); },
    fetchImpl: async (url, opts) => { calls.push({ url, ua: opts.headers['user-agent'], body: opts.body }); return responses.shift(); }
  });
  assert.deepEqual(calls.map(c => c.url), [MIRRORS[1], MIRRORS[2], MIRRORS[0]]);
  assert.equal(calls[0].ua, 'UA (ops@example.com)');
  assert.match(decodeURIComponent(calls[0].body), /\[timeout:90\]/);
  assert.deepEqual(sleeps, [5000, 30000], 'first backoff 5 s; the 429 waits for Retry-After (30 s > 10 s)');
  assert.equal(result.listings.length, 1);
  assert.equal(result.mirror, MIRRORS[0]);
});

test('fetch: timeouts count as retryable; gives up after maxAttempts with the attempt log', async () => {
  let n = 0;
  await assert.rejects(
    fetchClinicListings({
      area, maxAttempts: 3, logger: quiet, sleepImpl: async () => {},
      fetchImpl: async () => { n += 1; throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }
    }),
    err => err.attempts.length === 3 && err.attempts.every(a => a.outcome === 'timeout')
  );
  assert.equal(n, 3);
  // A 400 is the query's fault: no retry.
  let m = 0;
  await assert.rejects(fetchClinicListings({ area, logger: quiet, sleepImpl: async () => {}, fetchImpl: async () => { m += 1; return { ok: false, status: 400, headers: { get: () => null } }; } }));
  assert.equal(m, 1);
});

test('email judgement: business domain only; personal webmail and named mailboxes refused', () => {
  const d = ['glowclinic.com'];
  assert.equal(judgeEmail('info@glowclinic.com', d).ok, true);
  assert.equal(judgeEmail('frontdesk@glowclinic.com', d).score, 2);
  assert.equal(judgeEmail('appointments@mail.glowclinic.com', d).ok, true);
  assert.equal(judgeEmail('glowclinic@gmail.com', d).reason, 'personal_webmail');
  assert.equal(judgeEmail('owner@yahoo.com', d).reason, 'personal_webmail');
  assert.equal(judgeEmail('jane.smith@glowclinic.com', d).reason, 'named_person');
  assert.equal(judgeEmail('info@someagency.com', d).reason, 'other_domain');
  assert.equal(judgeEmail('noreply@glowclinic.com', d).reason, 'junk');
});

test('page parsing: mailto, Cloudflare-obfuscated address, tel: links, leader names', () => {
  // "info@ab.co" XOR-encoded with key 0x42, as Cloudflare email protection writes it.
  const key = 0x42;
  const hex = key.toString(16) + [...'info@ab.co'].map(c => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0')).join('');
  const html = `<a href="mailto:Hello@Glow.com?subject=x">x</a> <span data-cfemail="${hex}"></span> logo@2x.png
    <a href="tel:+1 (305) 555-0142">call</a>`;
  assert.deepEqual(emailsOnPage(html).sort(), ['hello@glow.com', 'info@ab.co']);
  assert.deepEqual(phonesOnPage(html), ['+13055550142']);
  assert.equal(normalisePhone('555-0100'), null);

  assert.deepEqual(leaderOnPage('<p>Meet our Medical Director: Dr. Jane Smith, MD who leads</p>'), { name: 'Jane Smith', role: 'Medical Director', credential: 'MD' });
  assert.deepEqual(leaderOnPage('<h3>Maria Lopez, NP</h3><p> – Founder of the practice</p>'), { name: 'Maria Lopez', role: 'Founder', credential: 'NP' });
  assert.equal(leaderOnPage('<p>Our Team is led by experts. Book Now</p>'), null);
  assert.equal(leaderOnPage('<p>Owner Operated Med Spa</p>'), null);
});

test('crawl: home → contact/about/team, picks the role inbox on the clinic domain, phone and director', async () => {
  const pages = {
    'https://glowclinic.com/': `<a href="/contact-us">Contact</a><a href="/about">About</a><a href="https://facebook.com/x">fb</a>
       <p>Semaglutide weight loss and hormone therapy.</p> <a href="mailto:glowowner@gmail.com">x</a>`,
    'https://glowclinic.com/contact-us': '<a href="mailto:info@glowclinic.com">email</a> <a href="tel:3055550199">call</a> jane.smith@glowclinic.com',
    'https://glowclinic.com/about': '<p>Dr. Ana Ruiz, DO – Medical Director</p>'
  };
  const visited = [];
  const fetchImpl = async url => {
    visited.push(url);
    const html = pages[url];
    return html
      ? { ok: true, status: 200, url, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => html }
      : { ok: false, status: 404, url, headers: { get: () => 'text/html' } };
  };
  const site = await crawlClinicSite({ website: 'https://glowclinic.com/', fetchImpl, pageDelayMs: 0 });
  assert.equal(site.ok, true);
  assert.equal(site.email, 'info@glowclinic.com');
  assert.equal(site.emailSource, 'https://glowclinic.com/contact-us');
  assert.equal(site.phone, '+13055550199');
  assert.deepEqual(site.leader, { name: 'Ana Ruiz', role: 'Medical Director', credential: 'DO', sourceUrl: 'https://glowclinic.com/about' });
  assert.equal(site.refused.personal_webmail, 1);
  assert.equal(site.refused.named_person, 1);
  assert.ok(site.signals.includes('weight loss') && site.signals.includes('hormone'));
  assert.ok(!visited.some(u => u.includes('facebook')), 'never leaves the clinic site');
  assert.equal(visited[1], 'https://glowclinic.com/contact-us', 'contact page first');
});

test('crawl: unreachable site and webmail-only site produce no e-mail', async () => {
  const down = await crawlClinicSite({ website: 'https://down.example/', pageDelayMs: 0, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(down.ok, false);
  const webmailOnly = await crawlClinicSite({
    website: 'https://spa.example/', pageDelayMs: 0,
    fetchImpl: async url => ({ ok: true, status: 200, url, headers: { get: () => 'text/html' }, text: async () => 'contact spaowner@hotmail.com' })
  });
  assert.equal(webmailOnly.ok, true);
  assert.equal(webmailOnly.email, null);
  assert.ok(webmailOnly.refused.personal_webmail >= 1);
});

test('mapPool: bounded concurrency, results in order', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    live += 1; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 5));
    live -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});
