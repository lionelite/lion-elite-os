'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { calendarHref, type FunnelConfig, type FunnelSource } from '../lib/funnel';

type Step = 'vsl' | 'qualify' | 'book' | 'done';
type BrowserEvent = 'page_view' | 'video_play' | 'cta_revealed' | 'cta_click' | 'booking_click';

const SMS_CONSENT_TEXT =
  'I agree to receive text messages about my booking and follow-up at the number above. Message and data rates may apply. Reply STOP to opt out. Consent is not a condition of purchase.';

function newSessionId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'bp_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** One id per visitor per tab, so a reload is not a second visitor. */
function useSessionId(slug: string): string {
  const [id, setId] = useState('');
  useEffect(() => {
    const key = `bp-session:${slug}`;
    let value = '';
    try {
      value = sessionStorage.getItem(key) || '';
    } catch {
      /* storage blocked: fall through to an in-memory id */
    }
    if (!value) {
      value = newSessionId();
      try {
        sessionStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    }
    setId(value);
  }, [slug]);
  return id;
}

function readUtm(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    const v = params.get(`utm_${k}`);
    if (v) utm[k] = v;
  }
  return utm;
}

export default function VslFunnel({ config, source }: { config: FunnelConfig; source: FunnelSource }) {
  const sessionId = useSessionId(config.slug);
  const [step, setStep] = useState<Step>('vsl');
  const [showCta, setShowCta] = useState(config.ctaRevealSeconds === 0);
  const [lead, setLead] = useState({ name: '', email: '', phone: '' });
  const [answers, setAnswers] = useState<string[]>(() => config.qualificationQuestions.map(() => ''));
  const [smsConsent, setSmsConsent] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const sent = useRef(new Set<string>());

  // Analytics carry the session only — never the lead's identity.
  function track(event: BrowserEvent) {
    if (!sessionId || sent.current.has(event)) return;
    sent.current.add(event);
    void fetch('/api/funnel-events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: config.slug, event, sessionId, utm: readUtm(), referrer: document.referrer }),
      keepalive: true,
    }).catch(() => {});
  }

  useEffect(() => {
    if (!sessionId) return;
    track('page_view');
    if (config.ctaRevealSeconds === 0) {
      track('cta_revealed');
      return;
    }
    const t = setTimeout(() => {
      setShowCta(true);
      track('cta_revealed');
    }, config.ctaRevealSeconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, config.slug, config.ctaRevealSeconds]);

  const complete = useMemo(
    () => Boolean(lead.name.trim() && lead.email.trim() && lead.phone.trim() && answers.every(a => a.trim())),
    [lead, answers]
  );
  const bookingHref = sessionId ? calendarHref(config, sessionId) : '';

  function start() {
    track('cta_click');
    setStep('qualify');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!complete || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/funnel-leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: config.slug,
          sessionId,
          ...lead,
          answers,
          smsConsent,
          consentText: smsConsent ? SMS_CONSENT_TEXT : '',
          website: honeypot,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { persisted?: boolean; error?: string };
      if (!res.ok && res.status !== 202) throw new Error(body.error || 'We could not save your application. Please try again.');
      setPersisted(body.persisted !== false);
      setStep('book');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not save your application. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function openCalendar() {
    track('booking_click');
    setTimeout(() => setStep('done'), 400);
  }

  return (
    <main className="funnel-shell">
      <div className="brand">
        BUILDPIPELINE <span>VSL</span>
      </div>
      {source === 'demo' && (
        <div className="demo-banner" role="status">
          Demo mode — no funnel backend is configured, so nothing on this page is stored.
        </div>
      )}

      {step === 'vsl' && (
        <section className="funnel-card">
          <div className="eyebrow">AUTOMATED CLIENT ACQUISITION</div>
          <h1>{config.headline}</h1>
          <p className="sub">{config.subheadline}</p>
          <div className="video-wrap">
            {config.video.kind === 'iframe' ? (
              <iframe
                src={config.video.src}
                title="Presentation video"
                allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                allowFullScreen
                // No play tracking here on purpose: an embed's onLoad fires when
                // the player loads, not when anyone presses play, so it would
                // count every visitor as a viewer. Real play events need the
                // provider's player API; until then the VSL step is evidenced by
                // cta_revealed (the visitor stayed for the reveal delay).
              />
            ) : config.video.kind === 'file' ? (
              <video controls playsInline src={config.video.src} onPlay={() => track('video_play')} />
            ) : (
              <div className="video-placeholder">
                <div className="play">▶</div>
                <strong>VSL VIDEO</strong>
                <span>Paste a YouTube, Vimeo, Wistia, or hosted video URL into the funnel config</span>
              </div>
            )}
          </div>
          <div className="proof-grid">
            {config.proof.map(x => (
              <div key={x} className="proof">
                ✓ {x}
              </div>
            ))}
          </div>
          {showCta ? (
            <button className="button wide" onClick={start}>
              {config.ctaLabel} →
            </button>
          ) : (
            <div className="cta-wait">Keep watching — your next step will appear shortly.</div>
          )}
        </section>
      )}

      {step === 'qualify' && (
        <section className="funnel-card">
          <div className="eyebrow">STEP 2 OF 3</div>
          <h2>Tell us about your business</h2>
          <p className="sub">We’ll use this to determine the best next step.</p>
          <form onSubmit={submit} className="form" noValidate={false}>
            <label>
              Full name
              <input required autoComplete="name" value={lead.name} onChange={e => setLead({ ...lead, name: e.target.value })} />
            </label>
            <label>
              Work email
              <input required type="email" autoComplete="email" value={lead.email} onChange={e => setLead({ ...lead, email: e.target.value })} />
            </label>
            <label>
              Phone
              <input required type="tel" autoComplete="tel" value={lead.phone} onChange={e => setLead({ ...lead, phone: e.target.value })} />
            </label>
            {config.qualificationQuestions.map((q, i) => (
              <label key={q}>
                {q}
                <input
                  required
                  value={answers[i] || ''}
                  onChange={e => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
                />
              </label>
            ))}
            {/* Honeypot: hidden from people, filled by bots. */}
            <label className="hp" aria-hidden="true">
              Website
              <input tabIndex={-1} autoComplete="off" value={honeypot} onChange={e => setHoneypot(e.target.value)} />
            </label>
            {/* Unticked by default: TCPA needs an affirmative act, and texts are only planned when this is checked. */}
            <label className="consent">
              <input type="checkbox" checked={smsConsent} onChange={e => setSmsConsent(e.target.checked)} />
              <span>{SMS_CONSENT_TEXT} (Optional)</span>
            </label>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="button wide" type="submit" disabled={!complete || submitting || !sessionId}>
              {submitting ? 'Saving…' : 'Continue to Booking →'}
            </button>
          </form>
        </section>
      )}

      {step === 'book' && (
        <section className="funnel-card">
          <div className="eyebrow">STEP 3 OF 3</div>
          <h2>Book your strategy call</h2>
          {persisted === false && <p className="note">Demo mode: this application was not stored.</p>}
          {bookingHref ? (
            <>
              <p className="sub">Choose a time that works for you. The calendar opens in a new tab.</p>
              <a className="button wide" href={bookingHref} target="_blank" rel="noopener noreferrer" onClick={openCalendar}>
                Open Calendar →
              </a>
            </>
          ) : (
            <p className="sub">Booking isn’t connected for this funnel yet. Your application was received and the team will reach out to schedule.</p>
          )}
        </section>
      )}

      {step === 'done' && (
        <section className="funnel-card">
          <div className="eyebrow">ALMOST THERE</div>
          <h2>Finish booking in the calendar tab.</h2>
          {/* A click is not a booking: the meeting is confirmed when the calendar
              reports it, so this screen does not claim a conversion. */}
          <p className="sub">
            Once you pick a time you’ll get a calendar confirmation. If you closed the tab before choosing a slot, you can reopen it below.
          </p>
          {bookingHref && (
            <a className="button wide secondary" href={bookingHref} target="_blank" rel="noopener noreferrer">
              Reopen Calendar
            </a>
          )}
        </section>
      )}
    </main>
  );
}
