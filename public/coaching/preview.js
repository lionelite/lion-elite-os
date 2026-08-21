(() => {
  'use strict';

  // Owner preview shortcut — OPT-IN ONLY.
  //
  // This used to run on every page load. Three things went wrong with that,
  // all of them on the public sign-in screen:
  //
  //   1. Every visitor fired a coach login attempt with the hardcoded token
  //      below. The server rejects it (COACH_PORTAL_ADMIN_TOKEN is a strong
  //      generated value), so every visitor got a 401.
  //   2. The failure rewrote the "Sign in" heading to "Preview could not
  //      open" — displayed directly above the Start coaching button, which is
  //      the entry point to checkout.
  //   3. The coach login limiter allows 12 attempts per 15 minutes per IP, so
  //      roughly a dozen page loads from one address locked the real coach out
  //      of their own portal with a 429.
  //
  // It now runs only when explicitly asked for: /coaching/?preview=1
  //
  // Note that this can only ever succeed if COACH_PORTAL_ADMIN_TOKEN is set to
  // the literal value below. Do NOT do that — it turns a guessable string into
  // full coach access to every client record. Sign in with the real token from
  // the Render dashboard instead.

  const PREVIEW_TOKEN = 'preview-mode-enabled';

  const requested = new URLSearchParams(location.search).get('preview');
  if (requested !== '1') return;

  function showPreviewError(message) {
    const status = document.querySelector('#auth-message');
    if (status) status.textContent = message;
    const title = document.querySelector('#auth-screen .auth-card h2');
    if (title) title.textContent = 'Preview could not open';
  }

  async function openCoachPreview() {
    try {
      const sessionResponse = await fetch('/api/coaching/session', { credentials: 'same-origin', cache: 'no-store' });
      const session = await sessionResponse.json().catch(() => ({}));
      if (session?.actor?.actorType === 'coach') {
        location.hash ||= '#coach-clients';
        return;
      }

      const response = await fetch('/api/coaching/auth/coach', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: PREVIEW_TOKEN })
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Preview login failed (${response.status}).`);
      }

      if (payload?.actor?.actorType !== 'coach') {
        throw new Error('Preview login did not return a coach session.');
      }

      location.replace('/coaching/#coach-clients');
      location.reload();
    } catch (error) {
      console.error('[coaching-preview]', error);
      showPreviewError(error?.message || 'Preview could not open.');
    }
  }

  openCoachPreview();
})();
