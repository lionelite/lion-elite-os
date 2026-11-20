'use strict';

/**
 * Server half of clinic discovery: dedupe, store, count, log.
 *
 * The map search and the website crawl run on the GitHub Actions runner
 * (scripts/discover-clinics.js, .github/workflows/clinic-discovery.yml),
 * because Render's shared free-tier IPs are refused by Overpass. The runner has
 * no database credential; it posts what it found here, and this module — on the
 * service, which already holds DATABASE_URL — decides what is new and writes it.
 *
 * Prospects land as campaign `lion-elite-clinical`, stage `discovered`, through
 * PostgresProspectStore.create, so the existing fingerprint dedupe
 * (domain|phone|name|region) applies; on top of that a clinic whose website
 * domain or e-mail is already on record under ANY campaign is not stored again.
 * Nothing here sends: the hourly send job (clinic-outreach.yml) picks these up
 * and runs them through clinic-qualification + the 16-check engine as before.
 */

const { normalizeDomain } = require('../outreach-validation');
const { clinicRelevance } = require('../contacts/clinic-targeting');
const { neverEmailReason } = require('../outreach/never-email');
const { newYorkClock } = require('../outreach/send-cap');
const { PERSONAL_WEBMAIL } = require('./clinic-site-crawl');
const control = require('../outreach/outreach-control');

const CAMPAIGN_ID = 'lion-elite-clinical';
const DISCOVERED_BY = 'clinic-discovery';
const CURSOR_KEY = 'clinic_discovery_cursor';
const DEFAULT_DAILY_TARGET = 200;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS clinic_discovery_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date DATE NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'github',
  queried INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  with_website INTEGER NOT NULL DEFAULT 0,
  with_email INTEGER NOT NULL DEFAULT 0,
  stored INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS clinic_discovery_runs_date_idx ON clinic_discovery_runs(run_date);
`;

const str = (v, n = 300) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));
const int = v => Math.max(0, Math.trunc(Number(v) || 0));
const domainOfEmail = e => (String(e).includes('@') ? String(e).split('@').pop().toLowerCase() : '');

function createClinicDiscoveryStore(deps = {}) {
  const env = deps.env || process.env;
  const database = deps.database || require('../database');
  const db = { query: (...a) => database.query(...a) };
  const store = deps.store || new (require('../postgres-prospect-store').PostgresProspectStore)();
  const now = deps.now || (() => new Date());
  const logger = deps.logger || console;
  const areas = deps.areas || require('./discovery-run').DEFAULT_AREAS;
  const dailyTarget = () => Math.max(1, Number(env.CLINIC_DISCOVERY_DAILY_TARGET || DEFAULT_DAILY_TARGET));

  let schemaReady = false;
  async function ensureSchema() {
    if (schemaReady) return;
    await control.ensureSchema(db);
    await db.query(SCHEMA_SQL);
    schemaReady = true;
  }

  function today() { return newYorkClock(new Date(now())).date; }

  async function storedToday() {
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM prospects WHERE campaign_id = $1 AND enrichment->>'discoveredBy' = $2
         AND (created_at AT TIME ZONE 'America/New_York')::date = $3::date`, [CAMPAIGN_ID, DISCOVERED_BY, today()]);
    return r.rows[0].n;
  }

  /** What the runner needs to start: the day's progress, the metro cursor, the metros. */
  async function state() {
    await ensureSchema();
    const cursor = int(await control.getSetting(db, CURSOR_KEY, 0)) % areas.length;
    const { discoveryUserAgent } = require('./osm-source');
    return { date: today(), storedToday: await storedToday(), target: dailyTarget(), cursor, areas, userAgent: discoveryUserAgent(env) };
  }

  /**
   * Which of these site domains need no crawl: already a prospect (any
   * campaign, by website or e-mail domain), or crawled in the last 30 days with
   * no business e-mail found.
   */
  async function known({ domains = [] } = {}) {
    await ensureSchema();
    const wanted = [...new Set((Array.isArray(domains) ? domains : []).slice(0, 2000).map(d => normalizeDomain(String(d || ''))).filter(Boolean))];
    if (!wanted.length) return { known: [], noEmailRecently: [] };
    const prospects = await db.query(
      `SELECT DISTINCT d FROM (
         SELECT lower(regexp_replace(regexp_replace(coalesce(business->>'website', business->>'domain', ''), '^https?://(www\\.)?', ''), '[/:?#].*$', '')) AS d FROM prospects
         UNION ALL
         SELECT lower(split_part(contact->>'email', '@', 2)) FROM prospects WHERE coalesce(contact->>'email','') <> ''
       ) x WHERE d = ANY($1)`, [wanted]);
    const checks = await db.query(
      `SELECT domain FROM discovery_site_checks WHERE email_found = false AND checked_at > now() - interval '30 days' AND domain = ANY($1)`, [wanted]);
    return { known: prospects.rows.map(r => r.d), noEmailRecently: checks.rows.map(r => r.domain) };
  }

  /**
   * Store one metro's crawled clinics.
   * @param {object} body { area, areaIndex, candidates:[…], noEmailDomains:[…] }
   */
  async function storeBatch({ area, areaIndex, candidates = [], noEmailDomains = [] } = {}) {
    await ensureSchema();
    const label = str(area, 60);
    if (!areas.some(a => a.label === label)) {
      const error = new Error(`unknown metro ${label}`);
      error.code = 'UNKNOWN_AREA';
      throw error;
    }
    const result = { area: label, received: 0, stored: 0, duplicates: 0, refused: {}, storedIds: [] };
    const refuse = reason => { result.refused[reason] = (result.refused[reason] || 0) + 1; };

    for (const raw of (Array.isArray(candidates) ? candidates : []).slice(0, 500)) {
      result.received += 1;
      const email = String(raw?.email || '').trim().toLowerCase();
      const website = str(raw?.website, 300);
      const name = str(raw?.name, 200);
      const siteDomain = normalizeDomain(website || '');
      const mailDomain = domainOfEmail(email);
      if (!name || !website || !siteDomain) { refuse('incomplete'); continue; }
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { refuse('no_email'); continue; }
      // The runner already refuses these; the service does not trust it to.
      if (PERSONAL_WEBMAIL.has(mailDomain)) { refuse('personal_webmail'); continue; }
      if (!(mailDomain === siteDomain || mailDomain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${mailDomain}`))) { refuse('email_not_on_site_domain'); continue; }
      if (neverEmailReason(email, env)) { refuse('never_email'); continue; }
      const category = ['clinic', 'med-spa'].includes(raw?.category) ? raw.category : 'clinic';
      const relevance = clinicRelevance({ name, website, category });
      if (relevance.tier === 'exclude' || relevance.tier === 'low') { refuse(`tier_${relevance.tier}`); continue; }

      const seen = await db.query(
        `SELECT 1 FROM prospects WHERE lower(contact->>'email') = $1 OR lower(split_part(contact->>'email','@',2)) = $2
           OR lower(regexp_replace(regexp_replace(coalesce(business->>'website', business->>'domain', ''), '^https?://(www\\.)?', ''), '[/:?#].*$', '')) = $3
         LIMIT 1`, [email, mailDomain, siteDomain]);
      if (seen.rowCount) { result.duplicates += 1; continue; }

      const leader = raw?.leader && raw.leader.name ? {
        name: str(raw.leader.name, 120), role: str(raw.leader.role, 60), credential: str(raw.leader.credential, 20), sourceUrl: str(raw.leader.sourceUrl, 300)
      } : null;
      const phone = str(raw?.phone, 40);
      const created = await store.create({
        business: {
          name, displayName: name, website, domain: siteDomain, phone, address: str(raw?.address, 300),
          region: label, niche: category, speciality: str(raw?.speciality, 120), osmTag: str(raw?.osmTag, 60),
          sourcePlatform: 'openstreetmap', sourceRef: str(raw?.sourceRef, 80), leadership: leader
        },
        contact: { email, phone },
        campaignId: CAMPAIGN_ID,
        ownerId: DISCOVERED_BY
      }, DISCOVERED_BY);
      if (created.duplicate) { result.duplicates += 1; continue; }

      const at = new Date(now()).toISOString();
      await store.update(created.prospect.prospectId, {
        enrichment: {
          source: { type: 'public_directory', provider: 'openstreetmap-overpass', ref: str(raw?.sourceRef, 80) },
          discoveredBy: DISCOVERED_BY,
          verifiedAt: at,
          emailFrom: { url: str(raw?.emailSource, 300), kind: 'business website' },
          phoneFrom: str(raw?.phoneSource, 300) || (phone ? 'openstreetmap listing' : null),
          leadership: leader,
          siteSignals: (Array.isArray(raw?.signals) ? raw.signals : []).slice(0, 10).map(s => str(s, 40)),
          targetingTier: relevance.tier
        }
      }, DISCOVERED_BY);
      result.stored += 1;
      result.storedIds.push(created.prospect.prospectId);
    }

    for (const d of (Array.isArray(noEmailDomains) ? noEmailDomains : []).slice(0, 1000)) {
      const domain = normalizeDomain(String(d || ''));
      if (!domain) continue;
      await db.query(
        `INSERT INTO discovery_site_checks (domain, email_found, detail) VALUES ($1, false, $2)
         ON CONFLICT (domain) DO UPDATE SET email_found = false, detail = EXCLUDED.detail, checked_at = now()`,
        [domain, 'no business e-mail on home/contact/about/team pages']);
    }

    if (Number.isInteger(areaIndex)) await control.setSetting(db, CURSOR_KEY, (areaIndex + 1) % areas.length, DISCOVERED_BY);
    result.storedToday = await storedToday();
    result.target = dailyTarget();
    logger.log?.(`[clinic-discovery] ${label}: received ${result.received}, stored ${result.stored}, duplicates ${result.duplicates}, refused ${JSON.stringify(result.refused)}, storedToday ${result.storedToday}/${result.target}`);
    return result;
  }

  /** One row per runner pass, so the numbers survive the Actions log. */
  async function logRun({ trigger = 'github', totals = {}, metros = [], startedAt } = {}) {
    await ensureSchema();
    const r = await db.query(
      `INSERT INTO clinic_discovery_runs (run_date, trigger, queried, found, with_website, with_email, stored, summary, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, coalesce($9::timestamptz, now()), now()) RETURNING run_id`,
      [today(), str(trigger, 60) || 'github', int(totals.queried), int(totals.found), int(totals.withWebsite), int(totals.withEmail), int(totals.stored),
        JSON.stringify({ totals, metros: (Array.isArray(metros) ? metros : []).slice(0, 60) }), startedAt || null]);
    return { runId: r.rows[0].run_id, date: today(), storedToday: await storedToday(), target: dailyTarget() };
  }

  return { state, known, storeBatch, logRun, storedToday, ensureSchema };
}

module.exports = { createClinicDiscoveryStore, CAMPAIGN_ID, DISCOVERED_BY, CURSOR_KEY, DEFAULT_DAILY_TARGET, SCHEMA_SQL };
