(() => {
  'use strict';

  async function openCoachPreview() {
    try {
      const sessionResponse = await fetch('/api/coaching/session', { credentials: 'same-origin' });
      const session = await sessionResponse.json().catch(() => ({}));
      if (session?.actor) return;

      const response = await fetch('/api/coaching/auth/coach', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'preview' })
      });

      if (response.ok) location.reload();
    } catch {
      // Normal login UI remains as fallback if preview bootstrap fails.
    }
  }

  openCoachPreview();
})();
