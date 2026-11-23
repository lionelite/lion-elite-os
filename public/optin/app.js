(() => {
  'use strict';

  // Copy per lane. The lane also decides which pipeline the lead lands in.
  const LANE_COPY = {
    'beauty-client': {
      eyebrow: 'Lion Elite Beauty',
      headline: 'Coaching that actually holds you to it.',
      lede: 'Structure, accountability and a plan built around your life — not another generic template. Tell us where to reach you.'
    },
    'coach-platform': {
      eyebrow: 'Lion Elite for Coaches',
      headline: 'Run your coaching business in one place.',
      lede: 'Your own client roster, programming, check-ins and messaging — instead of spreadsheets and scattered texts. Tell us where to reach you and we will show you the platform.'
    }
  };
  const DEFAULT_LANE = 'beauty-client';

  const params = new URLSearchParams(location.search);
  const lane = LANE_COPY[params.get('lane')] ? params.get('lane') : DEFAULT_LANE;
  const source = (params.get('source') || 'join-page').slice(0, 80);

  const el = id => document.getElementById(id);
  const form = el('join-form');
  const message = el('message');
  const submit = el('submit');

  // The exact disclosure the person is shown. Fetched from the API and posted
  // back unchanged, so the stored consent record is provably the text that was
  // on screen. If it cannot be loaded, SMS opt-in stays disabled rather than
  // recording a consent nobody was shown.
  let smsDisclosure = '';

  function applyCopy() {
    const copy = LANE_COPY[lane];
    el('eyebrow').textContent = copy.eyebrow;
    el('headline').textContent = copy.headline;
    el('lede').textContent = copy.lede;
    document.title = `${copy.headline} · Lion Elite`;
  }

  function say(text, kind) {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  function smsBox() {
    return form.elements.smsMarketingConsent;
  }

  async function loadDisclosure() {
    const box = smsBox();
    try {
      const response = await fetch('/api/leads/lanes', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (!data.smsDisclosure) throw new Error('missing');
      smsDisclosure = data.smsDisclosure;
      el('sms-disclosure').textContent = smsDisclosure;
    } catch {
      box.checked = false;
      box.disabled = true;
      el('sms-disclosure').textContent =
        'Text updates are unavailable right now. You can still join by email.';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    say('', '');

    const data = Object.fromEntries(new FormData(form));
    const wantsSms = smsBox().checked;

    if (!String(data.email || '').trim()) {
      say('Please enter your email address.', 'error');
      form.elements.email.focus();
      return;
    }
    if (wantsSms && !String(data.phone || '').trim()) {
      say('Add your mobile number, or untick the text updates box.', 'error');
      form.elements.phone.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Joining…';

    try {
      const response = await fetch('/api/leads/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lane,
          source,
          name: data.name || '',
          email: data.email,
          phone: data.phone || '',
          // Quiet hours are enforced in the recipient's local time, and an
          // unknown zone fails closed — so capture it at the moment of consent.
          timezone: (() => {
            try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
            catch { return ''; }
          })(),
          emailMarketingConsent: form.elements.emailMarketingConsent.checked,
          smsMarketingConsent: wantsSms,
          // Verbatim, exactly as rendered above.
          smsConsentText: wantsSms ? smsDisclosure : ''
        })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        say(payload.error || 'Something went wrong. Please try again.', 'error');
        return;
      }

      const channels = [];
      if (payload.consent?.email) channels.push('email');
      if (payload.consent?.sms) channels.push('text');
      el('card').innerHTML = `
        <div class="done">
          <h2>You're in.</h2>
          <p>${channels.length
            ? `We'll be in touch by ${channels.join(' and ')}.`
            : 'We have your details and will reach out shortly.'}</p>
          <p class="note">Changed your mind? Reply STOP to any text, or use the unsubscribe link in any email.</p>
        </div>`;
    } catch {
      say('We could not reach the server. Please check your connection and try again.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Join';
    }
  });

  applyCopy();
  loadDisclosure();
})();
