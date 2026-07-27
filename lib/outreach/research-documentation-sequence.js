'use strict';

// "Not all batches are created equal" — a 4-email Research-Use-Only drip for
// Lion Elite Wellness, built on the documentation/verifiability angle (COAs,
// batch numbers, purity %, test dates). Premium blue aesthetic. This is OUR
// brand's take on the angle, not a copy of anyone else's creative.
//
// Every email's visible copy is run through the fail-closed compliance
// validator (research-only): documentation/quality framing only — no
// human-use, dosing, benefit, or transformation language.

const { validateContent, RESEARCH_DISCLAIMER_PHRASE } = require('../social/social-compliance');

const WORDMARK = 'LION ELITE WELLNESS';
const SITE = 'https://lionelitewellness.com';
const DISCLAIMER = `For ${RESEARCH_DISCLAIMER_PHRASE}. Not for human or veterinary use.`;

const PALETTE = Object.freeze({
  outer: '#071b33',
  heroTop: '#0b4a7a',
  heroBottom: '#082445',
  card: '#0e2f52',
  accent: '#4db8e8',
  accentSoft: '#8fd6f2',
  text: '#eaf4fb',
  muted: '#a7c6dd',
  line: '#1c476f'
});

// The sequence copy. `problem` = the undocumented-supplier reality (day arc);
// `answer` = Lion Elite's documented posture. All RUO-safe.
const SEQUENCE = Object.freeze([
  {
    day: 1,
    dayLabel: 'DAY 1 · THE ORDER ARRIVES',
    subject: 'Not all batches are created equal',
    preheader: "What you're actually paying for when the documentation isn't there.",
    headline: 'NOT ALL BATCHES ARE CREATED EQUAL',
    subhead: 'An unverified research compound from an undocumented supplier costs more than the price tag suggests. Here is what you are actually paying for.',
    problem: 'The order arrives. No COA link, no batch number on the label — just a PDF attached to the product page with no lab name behind it. It looks fine. Most undocumented batches do.',
    answer: 'Every Lion Elite Wellness research compound ships with a batch number printed on the label and a live, verifiable certificate of analysis — available before you order, not missing after it arrives.',
    cta: { label: 'View live COAs', href: `${SITE}/verify` }
  },
  {
    day: 7,
    dayLabel: 'DAY 7 · THE QUESTIONS START',
    subject: 'Day 7: the questions start',
    preheader: "Purity percentage isn't listed anywhere verifiable.",
    headline: 'WHAT PURITY ARE YOU WORKING WITH?',
    subhead: 'A week in, the research protocol is underway — and the questions start.',
    problem: 'Purity percentage is not listed anywhere verifiable. You are not certain what concentration the material actually is, and the documentation gap is now your problem to manage.',
    answer: 'Lion Elite lists purity percentage and batch-specific third-party testing up front, so the material is the known quantity in your research — never the unknown variable.',
    cta: { label: 'See purity + test data', href: `${SITE}/verify` }
  },
  {
    day: 14,
    dayLabel: 'DAY 14 · THE DATA DOESN’T ADD UP',
    subject: 'Day 14: the data doesn’t add up',
    preheader: 'Without verified batch data, you cannot isolate the variable.',
    headline: 'WHEN THE DATA DOESN’T ADD UP',
    subhead: 'Two weeks in. The research data is inconsistent — but is it the protocol, or the compound?',
    problem: 'Without verified batch data there is no way to isolate the variable. Weeks of work can hinge on whether the compound was what the label claimed.',
    answer: 'Every Lion Elite batch carries third-party test results tied to its batch number, so an unverifiable compound is never the hidden variable in your data.',
    cta: { label: 'Verify a batch', href: `${SITE}/verify` }
  },
  {
    day: 30,
    dayLabel: 'DAY 30 · BACK TO THE SUPPLIER',
    subject: 'Day 30: the real cost shows up',
    preheader: 'Documentation before the order — not missing after it.',
    headline: 'THE REAL COST SHOWS UP ON DAY 30',
    subhead: 'A month of research compromised by an unverifiable compound. The cheaper price tag is long forgotten.',
    problem: 'You go back to the supplier. No batch number on any third-party record. The email leads nowhere. The documentation gap the price tag hid has become the whole story.',
    answer: 'The difference at Lion Elite Wellness is simple: the documentation — live batch numbers, purity percentages, test dates — is there before the order is placed, not missing after it arrives.',
    cta: { label: 'Shop documented research supply', href: SITE },
    trust: ['Batch Numbers', 'Purity Percentages', 'Test Dates']
  }
]);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain-text rendition of the visible copy — this is what compliance validates
// (HTML tags would confuse the matcher) and also serves as the text/plain part.
function textOf(e) {
  const trust = e.trust ? `\nLive & Verifiable: ${e.trust.join(' · ')}` : '';
  return [
    e.headline,
    e.subhead,
    `${e.dayLabel}`,
    e.problem,
    e.answer,
    `${e.cta.label}: ${e.cta.href}`,
    trust,
    DISCLAIMER,
    `${WORDMARK} · ${SITE}`,
    'You are receiving this because you opted in to Lion Elite Wellness research updates. Unsubscribe: {{unsubscribe_url}}',
    'Lion Elite Wellness, {{postal_address}}'
  ].filter(Boolean).join('\n\n');
}

function trustRow(e) {
  if (!e.trust) return '';
  const cells = e.trust.map((t) => `
        <td align="center" style="padding:0 10px;">
          <div style="width:54px;height:54px;border-radius:50%;background:${PALETTE.card};border:1px solid ${PALETTE.line};margin:0 auto 8px;line-height:54px;color:${PALETTE.accentSoft};font-size:22px;">&#10003;</div>
          <div style="color:${PALETTE.muted};font-size:12px;letter-spacing:.5px;">${esc(t)}</div>
        </td>`).join('');
  return `
    <tr><td style="padding:8px 30px 0;">
      <div style="color:${PALETTE.accentSoft};font-size:15px;font-weight:bold;letter-spacing:1px;text-align:center;padding-bottom:14px;">LIVE &amp; VERIFIABLE</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>
    </td></tr>`;
}

// One email, email-client-safe (table layout, inline styles, gradient with a
// solid-color fallback).
function renderEmailHtml(e) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(e.subject)}</title></head>
<body style="margin:0;padding:0;background:${PALETTE.outer};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(e.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.outer};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${PALETTE.heroBottom};border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <!-- header -->
    <tr><td style="padding:22px 30px 6px;">
      <div style="color:${PALETTE.accentSoft};font-size:14px;font-weight:bold;letter-spacing:3px;">&#9673; ${WORDMARK}</div>
    </td></tr>
    <!-- hero -->
    <tr><td style="background:${PALETTE.heroTop};background:linear-gradient(160deg,${PALETTE.heroTop},${PALETTE.heroBottom});padding:26px 30px 30px;">
      <div style="color:${PALETTE.accent};font-size:12px;font-weight:bold;letter-spacing:2px;padding-bottom:12px;">${esc(e.dayLabel)}</div>
      <div style="color:#ffffff;font-size:30px;line-height:1.15;font-weight:800;letter-spacing:.5px;">${esc(e.headline)}</div>
      <div style="color:${PALETTE.muted};font-size:15px;line-height:1.6;padding-top:14px;">${esc(e.subhead)}</div>
    </td></tr>
    <!-- problem -->
    <tr><td style="padding:24px 30px 6px;">
      <div style="color:${PALETTE.text};font-size:15px;line-height:1.7;">${esc(e.problem)}</div>
    </td></tr>
    <!-- answer card -->
    <tr><td style="padding:14px 30px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETTE.card};border-left:3px solid ${PALETTE.accent};border-radius:8px;">
        <tr><td style="padding:16px 18px;color:${PALETTE.text};font-size:15px;line-height:1.7;">${esc(e.answer)}</td></tr>
      </table>
    </td></tr>
    <!-- cta -->
    <tr><td align="center" style="padding:24px 30px 6px;">
      <a href="${esc(e.cta.href)}" style="display:inline-block;background:#ffffff;color:${PALETTE.heroBottom};text-decoration:none;font-size:15px;font-weight:bold;letter-spacing:.5px;padding:14px 30px;border-radius:30px;">${esc(e.cta.label)}</a>
    </td></tr>
    ${trustRow(e)}
    <!-- footer -->
    <tr><td style="padding:26px 30px 28px;border-top:1px solid ${PALETTE.line};margin-top:10px;">
      <div style="color:${PALETTE.accentSoft};font-size:12px;letter-spacing:.4px;">${esc(DISCLAIMER)}</div>
      <div style="color:${PALETTE.muted};font-size:12px;padding-top:10px;">${WORDMARK} &nbsp;&#183;&nbsp; <a href="${SITE}" style="color:${PALETTE.accentSoft};text-decoration:none;">lionelitewellness.com</a></div>
      <div style="color:#6f93ad;font-size:11px;line-height:1.6;padding-top:10px;">You opted in to Lion Elite Wellness research updates. <a href="{{unsubscribe_url}}" style="color:#8fb6d0;">Unsubscribe</a>.<br>Lion Elite Wellness, {{postal_address}}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// Build the full sequence with compliance results attached.
function buildSequence() {
  return SEQUENCE.map((e) => {
    const text = textOf(e);
    const compliance = validateContent({ text, complianceMode: 'research-only', requireDisclaimer: true });
    return {
      day: e.day,
      subject: e.subject,
      preheader: e.preheader,
      html: renderEmailHtml(e),
      text,
      compliance,
      approved: compliance.approved
    };
  });
}

module.exports = { WORDMARK, PALETTE, SEQUENCE, DISCLAIMER, renderEmailHtml, buildSequence, textOf };
