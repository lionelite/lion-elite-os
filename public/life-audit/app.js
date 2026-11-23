(() => {
  'use strict';

  const form = document.getElementById('life-audit-form');
  const message = document.getElementById('message');
  const submit = document.getElementById('submit');
  const smsDisclosureEl = document.getElementById('sms-disclosure');
  let smsDisclosure = '';

  function say(text, kind) {
    message.textContent = text;
    message.dataset.kind = kind || '';
  }

  async function loadDisclosure() {
    const box = form.elements.smsMarketingConsent;
    try {
      const response = await fetch('/api/leads/lanes', { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (!data.smsDisclosure) throw new Error('missing');
      smsDisclosure = data.smsDisclosure;
      smsDisclosureEl.textContent = smsDisclosure;
    } catch {
      box.checked = false;
      box.disabled = true;
      smsDisclosureEl.textContent = 'Text updates are unavailable right now. You can still continue by email.';
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    say('', '');

    const data = Object.fromEntries(new FormData(form));
    const goal = String(data.goal || '').trim();
    const email = String(data.email || '').trim();
    const wantsSms = form.elements.smsMarketingConsent.checked;

    if (!goal) {
      say('Choose the area you want to change first.', 'error');
      form.elements.goal.focus();
      return;
    }
    if (!email) {
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
    submit.textContent = 'Starting…';

    try {
      const response = await fetch('/api/leads/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lane: 'life-transformation',
          source: ('life-audit:' + goal).slice(0, 80),
          name: data.name || '',
          email,
          phone: data.phone || '',
          timezone: (() => {
            try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
            catch { return ''; }
          })(),
          emailMarketingConsent: form.elements.emailMarketingConsent.checked,
          smsMarketingConsent: wantsSms,
          smsConsentText: wantsSms ? smsDisclosure : ''
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        say(payload.error || 'Something went wrong. Please try again.', 'error');
        return;
      }

      document.getElementById('card').innerHTML = `
        <div class="done">
          <h2>Your Life Audit has started.</h2>
          <p>We have your first priority. The next step is to map your current state, desired future, biggest gaps and the actions that can create the most change over the next 30, 90 and 365 days.</p>
          <p class="note">Watch for the next step using the contact method you selected.</p>
        </div>`;
    } catch {
      say('We could not reach the server. Please check your connection and try again.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Start My Life Audit';
    }
  });

  loadDisclosure();
})();