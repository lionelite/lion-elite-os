(() => {
  'use strict';

  const API = '/api/coaching';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ageDays = value => value ? Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000)) : 999;

  async function api(path) {
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load coach home.');
    return payload;
  }

  function isCoach() {
    const sidebar = document.querySelector('#coach-sidebar');
    return Boolean(sidebar && !sidebar.classList.contains('hidden'));
  }

  function priority(client) {
    const unread = Number(client.unreadCount || 0);
    const overdue = ageDays(client.lastCheckinAt) > 7 ? 1 : 0;
    const inactive = ageDays(client.updatedAt || client.lastMessageAt || client.lastCheckinAt) > 7 ? 1 : 0;
    return unread * 100 + overdue * 40 + inactive * 20 + (client.status === 'paused' ? 10 : 0);
  }

  function attentionReason(client) {
    const reasons = [];
    if (Number(client.unreadCount || 0)) reasons.push(`${client.unreadCount} unread message${Number(client.unreadCount) === 1 ? '' : 's'}`);
    if (ageDays(client.lastCheckinAt) > 7) reasons.push('check-in due');
    if (ageDays(client.updatedAt || client.lastMessageAt || client.lastCheckinAt) > 7) reasons.push('inactive 7d+');
    if (client.status === 'paused') reasons.push('paused');
    return reasons.join(' · ') || 'On track';
  }

  function ensureHomeNav() {
    if (!isCoach()) return;
    const sidebar = document.querySelector('#coach-sidebar');
    if (!sidebar || sidebar.querySelector('[data-coach-home-nav]')) return;
    const firstButton = sidebar.querySelector('button[data-view]');
    if (!firstButton) return;
    const home = document.createElement('button');
    home.type = 'button';
    home.dataset.coachHomeNav = 'true';
    home.className = firstButton.className;
    home.innerHTML = '<span>⌂</span><span>Dashboard</span>';
    home.addEventListener('click', event => {
      event.preventDefault();
      history.pushState(null, '', '#coach-home');
      renderHome();
    });
    firstButton.parentElement.insertBefore(home, firstButton);
  }

  function renderClientRows(clients) {
    return clients.slice(0, 6).map(client => `
      <button type="button" class="le-home-client" data-home-client="${esc(client.clientId)}">
        <span class="le-home-avatar">${esc(`${client.firstName?.[0] || ''}${client.lastName?.[0] || ''}`.toUpperCase() || 'LE')}</span>
        <span class="le-home-client__name"><b>${esc(`${client.firstName || ''} ${client.lastName || ''}`.trim())}</b><small>${esc(attentionReason(client))}</small></span>
        <span class="le-home-client__status">${client.status === 'active' ? 'Active' : esc(client.status || 'Active')}</span>
        <span aria-hidden="true">→</span>
      </button>`).join('');
  }

  async function renderHome() {
    if (!isCoach()) return;
    const main = document.querySelector('#main-content');
    if (!main) return;
    main.innerHTML = '<div class="le-home-loading">Loading coach dashboard…</div>';
    try {
      const { clients = [] } = await api('/admin/clients');
      const active = clients.filter(c => c.status === 'active').length;
      const paused = clients.filter(c => c.status === 'paused').length;
      const unread = clients.reduce((sum, c) => sum + Number(c.unreadCount || 0), 0);
      const due = clients.filter(c => ageDays(c.lastCheckinAt) > 7).length;
      const inactive = clients.filter(c => ageDays(c.updatedAt || c.lastMessageAt || c.lastCheckinAt) > 7).length;
      const attention = clients.filter(c => priority(c) > 0).sort((a, b) => priority(b) - priority(a));
      const healthy = Math.max(0, clients.length - attention.length);
      const today = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

      main.innerHTML = `
        <section class="le-home-shell" data-coach-home>
          <header class="le-home-head">
            <div><p>COACH COMMAND CENTER</p><h1>Dashboard</h1><span>${esc(today)} · Know exactly who needs you today.</span></div>
            <div class="le-home-actions"><button type="button" data-view="coach-clients">+ Add / Manage Clients</button><button type="button" data-view="coach-workouts">Build Program</button></div>
          </header>

          <section class="le-home-kpis">
            <article><span>Active clients</span><strong>${active}</strong><small>${paused ? `${paused} paused` : 'All active'}</small></article>
            <article><span>Unread messages</span><strong>${unread}</strong><small>${unread ? 'Needs response' : 'Inbox clear'}</small></article>
            <article><span>Check-ins due</span><strong>${due}</strong><small>7+ days since check-in</small></article>
            <article><span>Inactive clients</span><strong>${inactive}</strong><small>7+ days without activity</small></article>
          </section>

          <div class="le-home-grid">
            <section class="le-home-panel le-home-panel--attention">
              <div class="le-home-panel__head"><div><p>PRIORITY</p><h2>Needs your attention</h2></div><span>${attention.length}</span></div>
              ${attention.length ? `<div class="le-home-client-list">${renderClientRows(attention)}</div>` : '<div class="le-home-empty"><strong>Everyone is caught up.</strong><span>No unread messages, overdue check-ins, or inactive clients.</span></div>'}
            </section>

            <aside class="le-home-rail">
              <section class="le-home-panel le-home-health">
                <div class="le-home-panel__head"><div><p>CLIENT HEALTH</p><h2>Portfolio snapshot</h2></div></div>
                <div class="le-health-ring" style="--score:${clients.length ? Math.round((healthy / clients.length) * 100) : 100}"><strong>${clients.length ? Math.round((healthy / clients.length) * 100) : 100}%</strong><span>on track</span></div>
                <div class="le-health-meta"><span><b>${healthy}</b> on track</span><span><b>${attention.length}</b> need attention</span></div>
              </section>

              <section class="le-home-panel">
                <div class="le-home-panel__head"><div><p>QUICK ACTIONS</p><h2>Coach tools</h2></div></div>
                <div class="le-home-quick"><button type="button" data-view="coach-clients">Clients</button><button type="button" data-view="coach-workouts">Programs</button><button type="button" data-view="coach-care">Nutrition & Care</button><button type="button" data-view="coach-messages">Messages</button><button type="button" data-view="coach-library">Exercise Library</button></div>
              </section>
            </aside>
          </div>
        </section>`;

      for (const button of main.querySelectorAll('[data-home-client]')) {
        button.addEventListener('click', () => {
          const target = document.querySelector(`[data-action="select-client"][data-client-id="${CSS.escape(button.dataset.homeClient)}"]`);
          if (target) target.click();
          else history.pushState(null, '', '#coach-clients');
        });
      }
      ensureHomeNav();
    } catch (error) {
      main.innerHTML = `<div class="le-home-error"><strong>Coach dashboard could not load.</strong><span>${esc(error.message)}</span></div>`;
    }
  }

  function sync() {
    if (!isCoach()) return;
    ensureHomeNav();
    if (location.hash === '#coach-home') renderHome();
  }

  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]');
    if (view && location.hash === '#coach-home') setTimeout(sync, 0);
  });
  window.addEventListener('hashchange', sync);
  window.addEventListener('load', () => setTimeout(sync, 500));
  new MutationObserver(() => setTimeout(sync, 20)).observe(document.documentElement, { subtree: true, childList: true });
})();