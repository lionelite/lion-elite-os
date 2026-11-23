(() => {
  'use strict';

  const API = '/api/coaching';
  let detailOpen = false;
  let currentClientId = null;
  let clients = [];
  let selected = null;
  let busy = false;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const initials = client => `${client?.firstName?.[0] || ''}${client?.lastName?.[0] || ''}`.toUpperCase() || 'LE';
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

  async function api(path, options = {}) {
    const init = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (options.body && typeof options.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${API}${path}`, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to complete coach action.');
    return payload;
  }

  function notice(message, type = 'success') {
    let node = document.querySelector('[data-coach-notice]');
    if (!node) {
      node = document.createElement('div');
      node.dataset.coachNotice = 'true';
      node.className = 'le-coach-notice';
      document.body.append(node);
    }
    node.className = `le-coach-notice ${type === 'error' ? 'is-error' : ''}`;
    node.textContent = message;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => node.remove(), 3600);
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

  function checkInOptions(value) {
    const days = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return days.map(day => `<option value="${day}" ${day === value ? 'selected' : ''}>${day || 'Not set'}</option>`).join('');
  }

  function renderCoachControls(client, profile) {
    return `
      <article class="le-detail-card le-coach-controls">
        <div class="le-detail-card__head"><h3>Coach Controls</h3><span class="le-save-state">LIVE</span></div>
        <form data-form="coach-client-update" class="le-coach-controls__form">
          <label>Status
            <select name="status">
              <option value="active" ${client.status === 'active' ? 'selected' : ''}>Connected</option>
              <option value="paused" ${client.status === 'paused' ? 'selected' : ''}>Paused</option>
              <option value="archived" ${client.status === 'archived' ? 'selected' : ''}>Archived</option>
            </select>
          </label>
          <label>Primary goal
            <textarea name="goal" maxlength="500" rows="3">${esc(profile.goal || '')}</textarea>
          </label>
          <label>Coach notes
            <textarea name="primaryObstacle" maxlength="1500" rows="4" placeholder="What matters most at the next check-in?">${esc(profile.primaryObstacle || '')}</textarea>
          </label>
          <label>Limitations / injuries
            <textarea name="limitations" maxlength="1500" rows="3">${esc(profile.limitations || '')}</textarea>
          </label>
          <label>Preferred check-in day
            <select name="preferredCheckInDay">${checkInOptions(profile.preferredCheckInDay || '')}</select>
          </label>
          <button class="le-primary-action" type="submit">Save Client</button>
        </form>
      </article>`;
  }

  function renderQuickMessage() {
    return `
      <article class="le-detail-card le-quick-message-card">
        <div class="le-detail-card__head"><h3>Quick Message</h3><span>💬</span></div>
        <form data-form="coach-detail-message" class="le-quick-message-form">
          <textarea name="body" rows="4" maxlength="2000" required placeholder="Send a quick update, reminder, or feedback…"></textarea>
          <button class="le-primary-action" type="submit">Send Message</button>
        </form>
      </article>`;
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
          <span class="le-client-live-status le-client-live-status--${esc(client.status || 'active')}">${esc(client.status === 'active' ? 'Connected' : client.status || 'active')}</span>
          <div class="le-client-detail__top-actions"><button type="button" data-detail-message-focus>Message</button><button type="button" data-detail-invite>Send App Invite</button></div>
        </header>
        <nav class="le-client-tabs">
          <button class="active" type="button">Overview</button>
          <button type="button" data-view="coach-workouts">Training</button>
          <button type="button" data-detail-message-focus>Messages</button>
          <button type="button">Metrics</button>
          <button type="button" data-view="coach-care">Nutrition</button>
          <button type="button" data-view="coach-care">Meal Plan</button>
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
              <div class="le-detail-card__head"><h2>Body Metrics Overview</h2><span>${latest ? `Last check-in ${relative(latest.createdAt)}` : 'No check-in yet'}</span></div>
              <div class="le-weight-current"><span>Weight</span><strong>${latest?.weightLbs ? `${esc(latest.weightLbs)}<small> lb</small>` : '—'}</strong></div>
              <div class="le-chart-wrap">${miniChart(weights)}</div>
              <div class="le-metric-foot"><span>${weights.length} recorded check-ins</span><span>${latest?.energy ? `Energy ${esc(latest.energy)}/10` : ''}</span></div>
            </article>
            ${renderQuickMessage()}
          </section>

          <section class="le-detail-midcol">
            ${renderCoachControls(client, profile)}
            <article class="le-detail-card"><h3>🎯 Goal</h3><div class="le-goal-box"><strong>Primary Goal</strong><p>${esc(profile.goal || 'Add a client goal here')}</p></div></article>
            <article class="le-detail-card"><h3>📝 Coach Notes</h3><div class="le-note-box">${esc(profile.primaryObstacle || 'No coach notes yet.')}</div></article>
            <article class="le-detail-card"><h3>🩹 Limitations/Injuries</h3><div class="le-note-box">${esc(profile.limitations || 'No limitations or injuries recorded.')}</div></article>
          </section>

          <aside class="le-detail-rightcol">
            <article class="le-detail-card le-profile-card"><h2>Profile</h2><div class="le-profile-lines"><p>✉ ${esc(client.email || '—')}</p><p>◎ ${esc(profile.goal || 'Goal not set')}</p><p>◷ ${esc(profile.preferredCheckInDay || 'Check-in day not set')}</p><p>◫ ${esc(profile.daysPerWeek || 3)} training days/week</p><p>⌁ ${esc(profile.typicalSleepHours ?? '—')} sleep hrs</p></div></article>
            <article class="le-detail-card le-updates-card"><div class="le-detail-card__head"><h2>Updates</h2><span>${updates.length} recent</span></div><div class="le-updates-list">${updates.length ? updates.map(item => `<div class="le-update"><span class="le-update-icon">${item.type === 'message' ? '💬' : item.type === 'workout' ? '🏋' : '✓'}</span><div><p>${esc(item.text)}</p>${item.detail ? `<small>${esc(item.detail)}</small>` : ''}</div><time>${relative(item.at)}</time></div>`).join('') : '<div class="le-update-empty">No recent activity yet.</div>'}</div></article>
            <article class="le-detail-card le-app-access-card"><h3>Client App Access</h3><p>Generate a fresh private link whenever the client needs to activate Lion Elite on a new device.</p><button class="le-primary-action" type="button" data-detail-invite>Generate & Copy Invite</button><div class="le-invite-result" data-invite-result hidden></div></article>
          </aside>
        </div>

        <div class="le-detail-quickbar"><button type="button" data-view="coach-workouts">🏋 Assign / Review Program</button><button type="button" data-detail-message-focus>💬 Message Client</button><button type="button" data-view="coach-care">◎ Update Plan</button><span>${completed}/${Math.max(totalPlanDays, completed)} workouts logged</span></div>
      </div>`;
    renderSidebar();
  }

  async function refreshCurrent() {
    if (!currentClientId) return;
    const [roster, clientData] = await Promise.all([api('/admin/clients'), api(`/admin/clients/${encodeURIComponent(currentClientId)}`)]);
    clients = roster.clients || [];
    selected = clientData;
    renderDetail();
  }

  async function openClient(clientId) {
    if (!isCoach()) return;
    currentClientId = clientId;
    detailOpen = true;
    try {
      await refreshCurrent();
    } catch (error) {
      detailOpen = false;
      console.error('[coaching-detail]', error);
      notice(error.message, 'error');
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

  async function saveClient(form) {
    if (busy || !selected?.client) return;
    busy = true;
    const button = form.querySelector('button[type="submit"]');
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Saving…'; }
    try {
      const data = Object.fromEntries(new FormData(form));
      const client = selected.client;
      const profile = client.profile || {};
      await api(`/admin/clients/${encodeURIComponent(client.clientId)}`, {
        method: 'PATCH',
        body: {
          email: client.email,
          firstName: client.firstName,
          lastName: client.lastName,
          status: data.status,
          profile: {
            ...profile,
            goal: data.goal,
            primaryObstacle: data.primaryObstacle,
            limitations: data.limitations,
            preferredCheckInDay: data.preferredCheckInDay
          }
        }
      });
      await refreshCurrent();
      notice('Client profile saved.');
    } catch (error) {
      notice(error.message, 'error');
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = original || 'Save Client'; }
    }
  }

  async function sendQuickMessage(form) {
    if (busy || !currentClientId) return;
    const body = new FormData(form).get('body')?.trim();
    if (!body) return;
    busy = true;
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    try {
      await api(`/admin/clients/${encodeURIComponent(currentClientId)}/messages`, { method: 'POST', body: { body } });
      form.reset();
      await refreshCurrent();
      notice('Message sent.');
    } catch (error) {
      notice(error.message, 'error');
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = 'Send Message'; }
    }
  }

  async function createInvite() {
    if (busy || !currentClientId) return;
    busy = true;
    try {
      const response = await api(`/admin/clients/${encodeURIComponent(currentClientId)}/invites`, { method: 'POST', body: {} });
      const url = response.invite?.url || '';
      if (url && navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
      const result = document.querySelector('[data-invite-result]');
      if (result) {
        result.hidden = false;
        result.innerHTML = `<strong>Invite ready</strong><input readonly value="${esc(url)}">`;
      }
      notice(url ? 'Fresh app invite copied.' : 'Fresh app invite created.');
    } catch (error) {
      notice(error.message, 'error');
    } finally {
      busy = false;
    }
  }

  document.addEventListener('click', event => {
    const row = event.target.closest('tr[data-action="select-client"]');
    if (row?.dataset.clientId) setTimeout(() => openClient(row.dataset.clientId), 250);
    const sideClient = event.target.closest('[data-detail-client]');
    if (sideClient) { event.preventDefault(); event.stopPropagation(); openClient(sideClient.dataset.detailClient); }
    if (event.target.closest('[data-detail-back]')) { event.preventDefault(); event.stopPropagation(); backToRoster(); }
    if (event.target.closest('[data-detail-invite]')) { event.preventDefault(); event.stopPropagation(); createInvite(); }
    if (event.target.closest('[data-detail-message-focus]')) {
      event.preventDefault();
      event.stopPropagation();
      document.querySelector('[data-form="coach-detail-message"] textarea')?.focus();
      document.querySelector('[data-form="coach-detail-message"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, true);

  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.matches('[data-form="coach-client-update"]')) {
      event.preventDefault();
      event.stopPropagation();
      saveClient(form);
    }
    if (form.matches('[data-form="coach-detail-message"]')) {
      event.preventDefault();
      event.stopPropagation();
      sendQuickMessage(form);
    }
  }, true);

  document.addEventListener('input', event => {
    if (!event.target.matches('[data-detail-search]')) return;
    const query = event.target.value.toLowerCase().trim();
    for (const button of document.querySelectorAll('[data-detail-client]')) button.hidden = query && !button.textContent.toLowerCase().includes(query);
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
  window.addEventListener('hashchange', () => { if (location.hash !== '#coach-clients') detailOpen = false; });
})();
