(() => {
  'use strict';

  const mode = window.LION_ELITE_APP_MODE || '';
  if (!mode) return;

  function applyMode() {
    const eyebrow = document.querySelector('#auth-screen .auth-card .eyebrow');
    const heading = document.querySelector('#auth-screen .auth-card h2');
    const copy = document.querySelector('#auth-screen .auth-card > .muted');
    const form = document.querySelector('#coach-login-form');
    const join = document.querySelector('#auth-screen .auth-join');
    const title = document.querySelector('title');

    if (mode === 'coach') {
      if (eyebrow) eyebrow.textContent = 'LION ELITE COACH';
      if (heading) heading.textContent = 'Coach sign in';
      if (copy) copy.textContent = 'Secure access to your client roster, programming, care plans, check-ins, progress, and messages.';
      if (title) title.textContent = 'Lion Elite Coach';
      return;
    }

    if (mode === 'client') {
      if (eyebrow) eyebrow.textContent = 'LION ELITE CLIENT';
      if (heading) heading.textContent = 'Open your private app';
      if (copy) copy.textContent = 'Use the private invite link your coach sent you. Once activated, this app keeps you signed in on your phone.';
      if (form) form.hidden = true;
      if (join) join.innerHTML = '<p class="muted">Need access?</p><p class="muted">Open the invite from your welcome message, or contact your coach for a fresh private link.</p>';
      if (title) title.textContent = 'Lion Elite';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyMode, { once: true });
  else applyMode();
})();