(() => {
  'use strict';

  const PREVIEW_TOKEN = 'preview-mode-enabled';

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
