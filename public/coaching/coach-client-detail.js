(() => {
  'use strict';

  const API = '/api/coaching';
  let detailOpen = false;
  let currentClientId = null;
  let clients = [];
  let selected = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const initials = client => `${client?.firstName?.[0] || ''}${client?.lastName?.[0] || ''}`.toUpperCase() || 'LE';
  const fmtDate = value => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
  };
  const relative = value => {
    if (!value) return '—';
    const diff = Math.max(0, Date.now() - new Date(value).getTime());
    const h = Math.floor(diff / 3600000);
    if (h < 1) return `${Math.max(1, Math.floor(diff / 60000))}m`;
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d`;
    const w = Math.floor(d / 7);
    return w < 52 ? `${w}w` : `${Math.floor(w / 52)}y`;
  };

  async function api(path) {
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load client.');
    return payload;
  }

  function isCoach() {
    const sidebar = document.querySelector('#coach-sidebar');
    return Boolean(sidebar && !sidebar.classList.contains('hidden'));
  }

  function allUpdates(data) {
    const dashboard = data?.dashboard || {};
    const items = [];
    for (const msg of dashboard.messages || []) items.push({ type: 'message', at: msg.createdAt, text: `${msg.senderName} sent a message`, detail: msg.body });
    for (const check of dashboard.checkins || []) items.push({ type: 'checkin', at: check.createdAt, text: 'Client submitted a check-in', detail: [check.weightLbs ? `${check.weightLbs} lb` : '', check.energy ? `Energy ${check.energy}/10` : ''].filter(Boolean).join(' · ') });
    for (const log of dashboard.workoutLogs || []) if (log.status === 'completed') items.push({ type: 'workout', at: log.completedAt || log.updatedAt, text: 'Client completed a workout', detail: log.feedback || '' });
    return items.filter(item => item.at).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8);
  }

  function trainingSummary(data) {
    const logs = (data?.dashboard?.workoutLogs || []).filter(log => log.status === 'completed');
    const now = Date.now();
    const d7 = logs.filter(log => now - new Date(log.completedAt || log.updatedAt).getTime() <= 7 * 86400000).length;
    const d30 = logs.filter(log => now - new Date(log.completedAt || log.updatedAt).getTime() <= 30 * 86400000).length;
    const plan = data?.dashboard?.workoutPlan;
    const nextWeek = plan?.days?.length || 0;
    return { d7, d30, nextWeek, last: logs.sort((a,b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt))[0] || null };
  }

  function metricRows(data) {
    const checkins = data?.dashboard?.checkins || [];
    return checkins.slice().reverse().map(c => ({ date: c.createdAt, value: c.weightLbs })).filter(x => x.value != null);
  }

  function miniChart(points) {
    if (points.length < 2) return `<div class="le-detail-empty-chart"><span>⌁</span><p>${points.length ? `Latest weight ${esc(points[0].value)} lb` : 'No weight data yet'}</p></div>`;
    const values = points.map(p => Number(p.value));
    const min = Math.min(...values), max = Math.max(...values), range = Math.max(1, max - min);
    const coords = values.map((v, i) => `${(i/(values.length-1))*100},${90-((v-min)/range)*70}`).join(' ');
    return `<svg class="le-weight-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Weight trend"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderSidebar() {
    const sidebar = document.querySelector('#coach-sidebar');
    if (!sidebar || !detailOpen) return;
    sidebar.innerHTML = `
      <div class="le-detail-sidebar-head"><small>CLIENTS</small><strong>All Clients</strong></div>
      <div class="le-detail-search"><span>⌕</span><input type="search" placeholder="Search client" data-detail-search></div>
      <div class="le-detail-client-list" data-detail-client-list>
        ${clients.map(client => `<button type="button" class="le-detail-client ${client.clientId === currentClientId ? 'active' : ''}" data-detail-client="${esc(client.clientId)}"><span class="le-detail-avatar">${esc(initials(client))}</span><span>${esc(`${client.firstName || ''} ${client.lastName || ''}`.trim())}</span>${Number(client.unreadCount || 0) ? `<i>${Number(client.unreadCount)}</i>` : ''}</button>`).join('')}
      </div>`;
  }

  function renderDetail() {
    if (!detailOpen || !selected) return;
    const main = document.querySelector('#main-content');
    if (!main) return;
    const client = selected.client;
    const profile = client.profile || {};
    const dashboard = selected.dashboard || {};
    const training = trainingSummary(selected);
    const latest = dashboard.checkins?.[0];
    const weights = metricRows(selected);
    const updates = allUpdates(selected);
    const workoutPlan = dashboard.workoutPlan;
    const totalPlanDays = workoutPlan?.days?.length || 0;
    const completed = (dashboard.workoutLogs || []).filter(l => l.status === 'completed').length;

    main.innerHTML = `
      <div class="le-client-detail" data-client-detail>
        <header class="le-client-detail__header">
          <button type="button" class="le-back-roster" data-detail-back>←</button>
          <span class="le-detail-avatar le-detail-avatar--large">${esc(initials(client))}</span>
          <div class="le-client-detail__identity"><h1>${esc(`${client.firstName || ''} ${client.lastName || ''}`.trim())}</h1><span>${esc(client.email || '')}</span></div>
          <div class="le-client-detail__top-actions"><button type="button" data-view="coach-messages">Message</button><button type="button" data-action="create-invite">Send App Invite</button></div>
        </header>
        <nav class="le-client-tabs">
          <button class="active" type="button" data-detail-tab="overview">Overview</button>
          <button type="button" data-view="coach-workouts">Training</button>
          <button type="button" data-detail-tab="tasks">Tasks</button>
          <button type="button" data-detail-tab="metrics">Metrics</button>
          <button type="button" data-view="coach-care">Nutrition</button>
          <button type="button" data-view="coach-care">Meal Plan</button>
          <button type="button" data-detail-tab="settings">Settings</button>
        </nav>

        <div class="le-detail-grid">
          <section class="le-detail-maincol">
            <article class="le-detail-card le-training-card">
              <h2>Training</h2>
              <div class="le-training-stats">
                <div><span>LAST 7 DAYS</span><strong>${training.d7}</strong><small>Tracked</small></div>
                <div><span>LAST 30 DAYS</span><strong>${training.d30}</strong><small>Tracked</small></div>
                <div><span>NEXT WEEK</span><strong>${training.nextWeek}</strong><small>${training.nextWeek ? 'Assigned' : 'Not assigned yet'}</small></div>
              </div>
            </article>
            <div class="le-last-workout"><span><b>Last Workout:</b> ${training.last ? `Completed ${relative(training.last.completedAt || training.last.updatedAt)} ago` : 'No completed workouts yet'}</span><button type="button" data-view="coach-workouts">Check Training</button></div>
            <article class="le-detail-card le-metrics-card">
              <div class="le-detail-card__head"><h2>Body Metrics Overview</h2><select><option>Last 4 weeks</option><option>Last 12 weeks</option></select></div>
              <div class="le-weight-current"><span>Weight</span><strong>${latest?.weightLbs ? `${esc(latest.weightLbs)}<small> lb</small>` : '—'}</strong></div>
              <div class="le-chart-wrap">${miniChart(weights)}</div>
              <div class="le-metric-foot"><span>${weights.length} recorded check-ins</span><button type="button" data-detail-tab="metrics">View all metrics</button></div>
            </article>
          </section>

          <section class="le-detail-midcol">
            <article class="le-detail-card"><h3>🎯 Goal & Countdown</h3><div class="le-goal-box"><strong>Primary Goal</strong><p>${esc(profile.goal || 'Add a client goal here')}</p></div></article>
            <article class="le-detail-card"><div class="le-detail-card__head"><h3>📝 Notes</h3><span>✎</span></div><div class="le-note-box">${esc(profile.primaryObstacle || 'Add coaching notes about this client…')}</div></article>
            <article class="le-detail-card"><div class="le-detail-card__head"><h3>🩹 Limitations/Injuries</h3><span>✎</span></div><div class="le-note-box">${esc(profile.limitations || 'No limitations or injuries recorded.')}</div></article>
            <article class="le-detail-card"><h3>🖼 Progress Photos</h3><div class="le-photo-empty">Client progress photos will appear here.</div></article>
          </section>

          <aside class="le-detail-rightcol">
            <article class="le-detail-card le-profile-card"><h2>Profile</h2><div class="le-profile-lines"><p>✉ ${esc(client.email || '—')}</p><p>◎ ${esc(profile.goal || 'Goal not set')}</p><p>◷ ${esc(profile.preferredCheckInDay || 'Check-in day not set')}</p><p>◫ ${esc(profile.daysPerWeek || 3)} training days/week</p><p>⌁ ${esc(profile.typicalSleepHours ?? '—')} sleep hrs</p></div></article>
            <article class="le-detail-card le-updates-card"><div class="le-detail-card__head"><h2>Updates</h2><select><option>Filter: All</option></select></div><div class="le-updates-list">${updates.length ? updates.map(item => `<div class="le-update"><span class="le-update-icon">${item.type === 'message' ? '💬' : item.type === 'workout' ? '🏋' : '✓'}</span><div><p>${esc(item.text)}</p>${item.detail ? `<small>${esc(item.detail)}</small>` : ''}</div><time>${relative(item.at)}</time></div>`).join('') : '<div class="le-update-empty">No recent activity yet.</div>'}</div></article>
          </aside>
        </div>

        <div class="le-detail-quickbar"><button type="button" data-view="coach-workouts">🏋 Assign / Review Program</button><button type="button" data-view="coach-messages">💬 Message Client</button><button type="button" data-view="coach-care">◎ Update Plan</button><span>${completed}/${Math.max(totalPlanDays, completed)} workouts logged</span></div>
      </div>`;
    renderSidebar();
  }

  async function openClient(clientId) {
    if (!isCoach()) return;
    currentClientId = clientId;
    detailOpen = true;
    try {
      const [roster, clientData] = await Promise.all([api('/admin/clients'), api(`/admin/clients/${encodeURIComponent(clientId)}`)]);
      clients = roster.clients || [];
      selected = clientData;
      renderDetail();
    } catch (error) {
      detailOpen = false;
      console.error('[coaching-detail]', error);
    }
  }

  function backToRoster() {
    detailOpen = false;
    currentClientId = null;
    selected = null;
    location.hash = '#coach-clients';
    document.querySelector('[data-view="coach-clients"]')?.click();
    window.dispatchEvent(new Event('hashchange'));
  }

  document.addEventListener('click', event => {
    const row = event.target.closest('tr[data-action="select-client"]');
    if (row?.dataset.clientId) setTimeout(() => openClient(row.dataset.clientId), 250);

    const sideClient = event.target.closest('[data-detail-client]');
    if (sideClient) {
      event.preventDefault();
      event.stopPropagation();
      openClient(sideClient.dataset.detailClient);
    }
    if (event.target.closest('[data-detail-back]')) {
      event.preventDefault();
      event.stopPropagation();
      backToRoster();
    }
  }, true);

  document.addEventListener('input', event => {
    if (!event.target.matches('[data-detail-search]')) return;
    const query = event.target.value.toLowerCase().trim();
    for (const button of document.querySelectorAll('[data-detail-client]')) {
      button.hidden = query && !button.textContent.toLowerCase().includes(query);
    }
  });

  const observer = new MutationObserver(() => {
    if (!detailOpen || !selected) return;
    const main = document.querySelector('#main-content');
    if (main && !main.querySelector('[data-client-detail]') && location.hash === '#coach-clients') setTimeout(renderDetail, 20);
  });

  window.addEventListener('load', () => {
    const root = document.querySelector('#app-shell');
    if (root) observer.observe(root, { childList: true, subtree: true });
  });
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#coach-clients') detailOpen = false;
  });
})();
