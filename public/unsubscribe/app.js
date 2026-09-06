(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const el = id => document.getElementById(id);
  const form = el('unsub-form');
  const message = el('message');
  const submit = el('submit');

  // Prefilled from the email link. The person still confirms — a one-click
  // unsubscribe that fires on page load gets triggered by mail clients and
  // link scanners prefetching the URL, unsubscribing people who never clicked.
  const email = (params.get('email') || '').trim();
  const token = params.get('t') || '';
  if (email) form.elements.email.value = email;

  function say(text, kind) {
    message.textContent = text;
    message.dataset.kind = kind;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = String(form.elements.email.value || '').trim();
    if (!value) {
      say('Enter the email address you want removed.', 'error');
      form.elements.email.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Removing…';
    try {
      const response = await fetch('/api/leads/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value, token })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        say(payload.error || 'Something went wrong. Please try again.', 'error');
        return;
      }
      // Deliberately the same wording whether or not the address was on a
      // list — this page must not confirm who we hold.
      el('card').innerHTML = `
        <div class="done">
          <h2>Done.</h2>
          <p>${value} has been unsubscribed from Lion Elite marketing email and texts.</p>
          <p class="note">It can take a short time for anything already queued to stop.</p>
        </div>`;
    } catch {
      say('We could not reach the server. Please check your connection and try again.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Unsubscribe me';
    }
  });
})();
