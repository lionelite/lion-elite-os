(() => {
  'use strict';

  const API = '/api/coaching';
  let rosterClients = [];
  let rendering = false;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const initials = client => `${client.firstName?.[0] || ''}${client.lastName?.[0] || ''}`.toUpperCase() || 'LE';
  const dateValue = value => value ? new Date(value).getTime() : 0;
  const relative = value => {
    if (!value) return '—';
    const diff = Math.max(0, Date.now() - new Date(value).getTime());
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'Now';
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    const wk = Math.floor(day / 7);
    if (wk < 52) return `${wk}w`;
    return `${Math.floor(wk / 52)}y`;
  };

  async function api(path) {
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Unable to load coaching roster.');
    return response.json();
  }

  function isCoachClientsView() {
    const sidebar = document.querySelector('#coach-sidebar');
    const main = document.querySelector('#main-content');
    if (!sidebar || sidebar.classList.contains('hidden') || !main) return false;
    return location.hash === '#coach-clients' || [...sidebar.querySelectorAll('[data-view]')].some(btn => btn.dataset.view === 'coach-clients' && btn.classList.contains('active'));
  }

  function selectedClientId() {
    return document.querySelector('.client-row.active')?.dataset.clientId || null;
  }

  function latestActivity(client) {
    const times = [client.updatedAt, client.lastMessageAt, client.lastCheckinAt].filter(Boolean);
    if (!times.length) return null;
    return new Date(Math.max(...times.map(dateValue))).toISOString();
  }

  function ageDays(value) {
    if (!value) return Infinity;
    return Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  }

  function attentionStats() {
    return {
      unread: rosterClients.filter(client => Number(client.unreadCount || 0) > 0).length,
      checkins: rosterClients.filter(client => client.status === 'active' && ageDays(client.lastCheckinAt) >= 7).length,
      inactive: rosterClients.filter(client => client.status === 'active' && ageDays(latestActivity(client)) >= 7).length,
      paused: rosterClients.filter(client => client.status === 'paused').length
    };
  }

  function attentionPanel() {
    const stats = attentionStats();
    return `
      <div class="le-coach-kpis" aria-label="Coach attention summary">
        <button type="button" data-le-attention="unread"><span>Unread Messages</span><strong>${stats.unread}</strong><small>Needs reply</small></button>
        <button type="button" data-le-attention="checkins"><span>Check-ins Due</span><strong>${stats.checkins}</strong><small>7+ days</small></button>
        <button type="button" data-le-attention="inactive"><span>Inactive Clients</span><strong>${stats.inactive}</strong><small>No activity 7+ days</small></button>
        <button type="button" data-le-attention="paused"><span>Paused</span><strong>${stats.paused}</strong><small>Review status</small></button>
      </div>`;
  }

  function createPanel() {
    return `
      <section class="le-create-panel" id="le-create-panel">
        <h2>Add a client</h2>
        <form data-form="create-client">
          <div class="form-grid">
            <label>First name<input name="firstName" required maxlength="80"></label>
            <label>Last name<input name="lastName" maxlength="80"></label>
            <label class="wide">Email<input name="email" type="email" required autocomplete="email"></label>
            <label class="wide">Primary goal<input name="goal" maxlength="500" placeholder="Lean six-pack, strength, consistency…"></label>
            <label>Training days/week<input name="daysPerWeek" type="number" min="1" max="7" value="3"></label>
            <label>Session minutes<input name="sessionMinutes" type="number" min="20" max="180" value="60"></label>
            <label class="wide">Available equipment<input name="equipment" placeholder="barbell, dumbbell, cable, bodyweight"></label>
            <label class="wide">Limitations / injuries<textarea name="limitations" maxlength="1500"></textarea></label>
          </div>
          <div style="margin-top:16px;display:flex;gap:10px">
            <button class="button button--gold" type="submit">Create client & send app invite</button>
            <button class="button" type="button" data-le-close-create>Cancel</button>
          </div>
        </form>
      </section>`;
  }

  function attentionLabel(client) {
    if (Number(client.unreadCount || 0) > 0) return '<span class="le-attention-chip is-red">Reply</span>';
    if (client.status === 'active' && ageDays(client.lastCheckinAt) >= 7) return '<span class="le-attention-chip is-gold">Check-in due</span>';
    if (client.status === 'active' && ageDays(latestActivity(client)) >= 7) return '<span class="le-attention-chip">Inactive</span>';
    return '';
  }

  function row(client, selected) {
    const activity = latestActivity(client);
    const unread = Number(client.unreadCount || 0);
    const status = client.status || 'active';
    return `
      <tr data-action="select-client" data-client-id="${esc(client.clientId)}" class="${selected === client.clientId ? 'is-selected' : ''}">
        <td><div class="le-client-name"><span class="le-client-avatar">${esc(initials(client))}</span><span><b>${esc(`${client.firstName || ''} ${client.lastName || ''}`.trim())}</b>${attentionLabel(client)}</span></div></td>
        <td class="le-activity">${esc(relative(activity))}</td>
        <td>${unread ? `<span class="le-message-badge">${unread}</span>` : '—'}</td>
        <td>—</td>
        <td class="le-program">${esc(client.profile?.goal || 'No goal set')}</td>
        <td>${esc(relative(client.lastCheckinAt))}</td>
        <td><span class="le-status le-status--${esc(status)}">${status === 'active' ? 'Connected' : esc(status[0].toUpperCase() + status.slice(1))}</span></td>
      </tr>`;
  }

  function drawRoster() {
    if (!isCoachClientsView()) return;
    const main = document.querySelector('#main-content');
    if (!main || rendering) return;
    const selected = selectedClientId();
    rendering = true;
    main.innerHTML = `
      <div class="le-roster" data-le-roster>
        <header class="le-roster__header">
          <div class="le-roster__title"><button class="le-roster__menu" type="button" aria-label="Menu">☰</button><div><p class="le-roster__eyebrow">COACH COMMAND CENTER</p><h1>All Clients (${rosterClients.length})</h1></div></div>
          <div class="le-roster__actions"><button class="le-roster__add" type="button" data-le-add-client>+ Add Client</button></div>
        </header>
        ${attentionPanel()}
        <div class="le-roster__filters">
          <select class="le-filter" data-le-status><option value="all">Status: All</option><option value="active">Status: Connected</option><option value="paused">Status: Paused</option><option value="archived">Status: Archived</option></select>
          <select class="le-filter" data-le-activity><option value="all">Last Activity</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
          <select class="le-filter" data-le-messages><option value="all">Messages: All</option><option value="unread">Unread only</option></select>
        </div>
        <div class="le-search"><span>⌕</span><input type="search" placeholder="Search client" data-le-search></div>
        ${selected ? `<div class="le-selected-strip"><strong>Client selected</strong><div class="le-selected-strip__actions"><button type="button" data-view="coach-workouts">Workouts</button><button type="button" data-view="coach-care">Plans</button><button type="button" data-view="coach-messages">Message</button></div></div>` : ''}
        ${createPanel()}
        <div class="le-table-wrap">
          <table class="le-client-table">
            <thead><tr><th>Name</th><th>Last Activity</th><th>Messages</th><th>Last 7d Training</th><th>Primary Goal</th><th>Last Check-in</th><th>Status</th></tr></thead>
            <tbody data-le-tbody>${rosterClients.length ? rosterClients.map(client => row(client, selected)).join('') : `<tr><td colspan="7"><div class="le-empty">No clients yet. Add your first coaching client.</div></td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
    rendering = false;
  }

  function applyFilters(custom = '') {
    const search = (document.querySelector('[data-le-search]')?.value || '').trim().toLowerCase();
    const status = document.querySelector('[data-le-status]')?.value || 'all';
    const activityDays = document.querySelector('[data-le-activity]')?.value || 'all';
    const messages = document.querySelector('[data-le-messages]')?.value || 'all';
    const selected = selectedClientId();
    const filtered = rosterClients.filter(client => {
      const text = `${client.firstName || ''} ${client.lastName || ''} ${client.email || ''} ${client.profile?.goal || ''}`.toLowerCase();
      if (search && !text.includes(search)) return false;
      if (status !== 'all' && client.status !== status) return false;
      if (messages === 'unread' && !Number(client.unreadCount || 0)) return false;
      if (activityDays !== 'all') {
        const last = latestActivity(client);
        if (!last || Date.now() - new Date(last).getTime() > Number(activityDays) * 86400000) return false;
      }
      if (custom === 'unread' && !Number(client.unreadCount || 0)) return false;
      if (custom === 'checkins' && !(client.status === 'active' && ageDays(client.lastCheckinAt) >= 7)) return false;
      if (custom === 'inactive' && !(client.status === 'active' && ageDays(latestActivity(client)) >= 7)) return false;
      if (custom === 'paused' && client.status !== 'paused') return false;
      return true;
    });
    const tbody = document.querySelector('[data-le-tbody]');
    if (tbody) tbody.innerHTML = filtered.length ? filtered.map(client => row(client, selected)).join('') : `<tr><td colspan="7"><div class="le-empty">No clients match this attention filter.</div></td></tr>`;
  }

  async function refresh() {
    if (!isCoachClientsView()) return;
    try {
      rosterClients = (await api('/admin/clients')).clients || [];
      drawRoster();
    } catch (_) {}
  }

  document.addEventListener('click', event => {
    if (event.target.closest('[data-le-add-client]')) document.querySelector('#le-create-panel')?.classList.add('is-open');
    if (event.target.closest('[data-le-close-create]')) document.querySelector('#le-create-panel')?.classList.remove('is-open');
    const attention = event.target.closest('[data-le-attention]');
    if (attention) applyFilters(attention.dataset.leAttention);
  });
  document.addEventListener('input', event => { if (event.target.matches('[data-le-search]')) applyFilters(); });
  document.addEventListener('change', event => { if (event.target.matches('[data-le-status],[data-le-activity],[data-le-messages]')) applyFilters(); });

  const observer = new MutationObserver(() => {
    if (rendering || !isCoachClientsView()) return;
    const main = document.querySelector('#main-content');
    if (main && !main.querySelector('[data-le-roster]')) setTimeout(drawRoster, 0);
  });

  window.addEventListener('load', () => {
    const root = document.querySelector('#app-shell');
    if (root) observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    setTimeout(refresh, 800);
  });
  window.addEventListener('hashchange', () => setTimeout(refresh, 120));
  document.addEventListener('submit', event => {
    if (event.target.matches('[data-form="create-client"]')) setTimeout(refresh, 1200);
  });
})();
