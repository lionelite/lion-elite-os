(() => {
  'use strict';

  const API = '/api/coaching';
  const state = {
    actor: null,
    config: null,
    dashboard: null,
    clients: [],
    exercises: [],
    selectedClientId: null,
    selected: null,
    currentView: '',
    careTab: 'nutrition',
    activeWorkoutDayId: null,
    deferredInstallPrompt: null,
    eventSource: null,
    lastInvite: null,
    coaches: [],
    leads: null,
    lastCoachToken: null
  };

  const elements = {
    splash: document.querySelector('#splash'),
    auth: document.querySelector('#auth-screen'),
    authMessage: document.querySelector('#auth-message'),
    shell: document.querySelector('#app-shell'),
    main: document.querySelector('#main-content'),
    bottomNav: document.querySelector('#bottom-nav'),
    sidebar: document.querySelector('#coach-sidebar'),
    portalLabel: document.querySelector('#portal-label'),
    avatar: document.querySelector('#avatar-button'),
    livePill: document.querySelector('#live-pill'),
    modal: document.querySelector('#modal-root'),
    toasts: document.querySelector('#toast-root')
  };

  const clientNav = [
    ['today', 'Today', '⌂'],
    ['workouts', 'Training', '◫'],
    ['plan', 'My Plan', '◎'],
    ['messages', 'Messages', '✦'],
    ['progress', 'Progress', '↗']
  ];
  const coachNav = [
    ['coach-clients', 'Clients', '◉'],
    ['coach-workouts', 'Workouts', '◫'],
    ['coach-care', 'Care Plans', '◎'],
    ['coach-messages', 'Messages', '✦'],
    ['coach-library', 'Video Library', '▶']
  ];
  // Coach administration belongs to the owner only; everyone else never sees
  // the tab, and the API refuses it regardless of what the UI renders.
  const ownerNav = [...coachNav, ['coach-leads', 'Leads', '◈'], ['coach-coaches', 'Coaches', '⚑']];
  function navForCoach() {
    return state.actor?.coach?.role === 'owner' ? ownerNav : coachNav;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function initials(firstName = '', lastName = '') {
    return `${firstName[0] || ''}${lastName[0] || ''}`.toUpperCase() || 'LE';
  }

  function formatDate(value, options = {}) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...options }).format(date);
  }

  function formatTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  }

  function lines(value) {
    return escapeHtml(value || '').replace(/\n/g, '<br>');
  }

  function emptyState(icon, title, copy, action = '') {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(copy)}</p>${action ? `<div class="cluster" style="justify-content:center;margin-top:18px">${action}</div>` : ''}</div>`;
  }

  function statusChip(status) {
    return `<span class="status-chip status-chip--${escapeHtml(status)}">${escapeHtml(status)}</span>`;
  }

  function profileReady(client) {
    return Boolean(client?.profile?.onboardingCompletedAt);
  }

  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'toast--error' : ''}`;
    node.textContent = message;
    elements.toasts.append(node);
    setTimeout(() => node.remove(), 4200);
  }

  async function api(path, options = {}) {
    const init = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (options.body && typeof options.body !== 'string') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${API}${path}`, init);
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || 'Something went wrong.');
      error.status = response.status;
      error.details = payload.details;
      throw error;
    }
    return payload;
  }

  function setLoading(form, loading) {
    for (const button of form.querySelectorAll('button[type="submit"]')) {
      button.disabled = loading;
      button.dataset.originalText ||= button.textContent;
      button.textContent = loading ? 'Working…' : button.dataset.originalText;
    }
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function currentHash() {
    return location.hash.replace(/^#/, '') || (state.actor?.actorType === 'coach' ? 'coach-clients' : 'today');
  }

  function navigate(view) {
    if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
    renderView(view);
  }

  function renderNav(items, active) {
    elements.bottomNav.innerHTML = items.map(([view, label, icon]) => `
      <button class="nav-button ${active === view ? 'active' : ''}" type="button" data-view="${view}" aria-current="${active === view ? 'page' : 'false'}">
        <span class="nav-icon">${icon}</span><span>${label}</span>
      </button>`).join('');
  }

  function showAuth(message = '') {
    state.actor = null;
    state.eventSource?.close();
    elements.splash.classList.add('hidden');
    elements.shell.classList.add('hidden');
    elements.auth.classList.remove('hidden');
    elements.authMessage.textContent = message;
  }

  async function enterApp(actor) {
    state.actor = actor;
    elements.splash.classList.add('hidden');
    elements.auth.classList.add('hidden');
    elements.shell.classList.remove('hidden');
    elements.portalLabel.textContent = actor.actorType === 'coach' ? 'Coach Portal' : 'Coaching';
    if (actor.actorType === 'coach') {
      const [coachFirst = '', coachLast = ''] = String(actor.coach?.name || '').split(' ');
      elements.avatar.textContent = initials(coachFirst, coachLast) || 'LE';
      elements.sidebar.classList.remove('hidden');
      await loadCoach();
    } else {
      elements.avatar.textContent = initials(actor.client?.firstName, actor.client?.lastName);
      elements.sidebar.classList.add('hidden');
      await loadClient();
      if (!profileReady(state.dashboard.client)) history.replaceState(null, '', '/coaching/#profile');
    }
    renderView(currentHash());
  }

  async function loadClient() {
    const response = await api('/dashboard');
    state.dashboard = response.dashboard;
    connectMessageStream();
  }

  async function loadCoach() {
    const [clients, exercises] = await Promise.all([api('/admin/clients'), api('/admin/exercises')]);
    state.clients = clients.clients;
    state.exercises = exercises.exercises;
    if (state.actor?.coach?.role === 'owner') {
      const [coaches, leads] = await Promise.all([api('/admin/coaches'), api('/admin/leads')]);
      state.coaches = coaches.coaches;
      state.leads = leads;
    }
    if (state.selectedClientId && state.clients.some(client => client.clientId === state.selectedClientId)) {
      await loadSelectedClient();
    } else if (state.clients.length) {
      state.selectedClientId = state.clients[0].clientId;
      await loadSelectedClient();
    }
    renderCoachSidebar();
  }

  async function loadSelectedClient() {
    if (!state.selectedClientId) { state.selected = null; return; }
    state.selected = await api(`/admin/clients/${state.selectedClientId}`);
    connectMessageStream();
  }

  function renderView(view) {
    if (!state.actor) return;
    const allowed = state.actor.actorType === 'coach' ? navForCoach().map(item => item[0]) : [...clientNav.map(item => item[0]), 'profile'];
    const fallback = state.actor.actorType === 'coach' ? 'coach-clients' : 'today';
    state.currentView = allowed.includes(view) ? view : fallback;
    if (state.actor.actorType === 'coach') {
      renderNav(navForCoach(), state.currentView);
      renderCoachSidebar();
      renderCoachView();
    } else {
      renderNav(clientNav, state.currentView);
      renderClientView();
    }
    elements.main.focus({ preventScroll: true });
  }

  function renderClientView() {
    const renders = {
      today: renderToday,
      workouts: renderWorkouts,
      plan: renderCarePlan,
      messages: () => renderMessages('client'),
      progress: renderProgress,
      profile: renderProfile
    };
    elements.main.innerHTML = (renders[state.currentView] || renderToday)();
    if (state.currentView === 'messages') scrollMessages();
  }

  function renderToday() {
    const dashboard = state.dashboard;
    const client = dashboard.client;
    const plan = dashboard.workoutPlan;
    const completedIds = new Set(dashboard.workoutLogs.filter(log => log.status === 'completed').map(log => log.workoutDayId));
    const nextDay = plan?.days.find(day => !completedIds.has(day.workoutDayId)) || plan?.days?.[0];
    const progress = plan?.days?.length ? Math.min(100, Math.round((completedIds.size / plan.days.length) * 100)) : 0;
    const checkin = dashboard.checkins[0];
    const recentMessage = dashboard.messages.at(-1);
    return `
      <section class="page-head">
        <p class="eyebrow">${new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</p>
        <h1>Ready, ${escapeHtml(client.firstName)}?</h1>
        <p class="muted">Everything your coach assigned is here. One day, one workout, one decision at a time.</p>
      </section>
      <div class="card-grid">
        <article class="card card--gold wide">
          <div class="spread">
            <div>
              <p class="eyebrow">NEXT SESSION</p>
              <h2>${escapeHtml(nextDay?.title || 'Your next workout is being built')}</h2>
              <p class="muted">${nextDay ? `${nextDay.exercises.length} exercises · video guidance included` : 'Your coach will publish it here when it is ready.'}</p>
            </div>
            ${plan ? `<div class="progress-ring" style="--progress:${progress}" data-label="${progress}%"></div>` : ''}
          </div>
          ${nextDay ? `<button class="button button--gold" type="button" data-action="open-workout" data-day-id="${nextDay.workoutDayId}">Start workout</button>` : ''}
        </article>
        <article class="card metric"><span>Current weight</span><strong>${checkin?.weightLbs ? `${checkin.weightLbs} lb` : '—'}</strong><small class="caption">Last check-in ${formatDate(checkin?.createdAt)}</small></article>
        <article class="card metric"><span>Sleep</span><strong>${checkin?.sleepHours ? `${checkin.sleepHours}h` : '—'}</strong><small class="caption">Recovery starts here</small></article>
        <article class="card metric"><span>Energy</span><strong>${checkin?.energy ? `${checkin.energy}/10` : '—'}</strong><small class="caption">Latest self-rating</small></article>
        <article class="card full">
          <div class="spread"><div><p class="eyebrow">COACH CONNECTION</p><h3>${recentMessage ? escapeHtml(recentMessage.senderName) : 'Direct access to your coach'}</h3></div><button class="button button--small" type="button" data-view="messages">Open chat</button></div>
          <p class="muted">${recentMessage ? escapeHtml(recentMessage.body) : 'Ask questions, share wins, and flag anything your coach should know.'}</p>
        </article>
      </div>
      <div class="section-head"><h2>This week</h2><button class="button button--ghost button--small" type="button" data-view="progress">Check in</button></div>
      <div class="card-grid">
        <article class="card"><p class="eyebrow">TRAINING</p><h3>${plan ? `${completedIds.size} sessions logged` : 'Plan pending'}</h3><p class="muted">${plan?.title || 'Your coach is preparing your program.'}</p></article>
        <article class="card"><p class="eyebrow">NUTRITION</p><h3>${dashboard.nutrition?.calorieTarget ? `${dashboard.nutrition.calorieTarget} calories` : 'Guidance pending'}</h3><p class="muted">${dashboard.nutrition?.title || 'Your plan will appear here.'}</p></article>
        <article class="card"><p class="eyebrow">ACCOUNTABILITY</p><h3>${dashboard.checkins.length} check-ins</h3><p class="muted">Keep the data honest so the plan can improve.</p></article>
      </div>`;
  }

  function renderWorkouts() {
    const plan = state.dashboard.workoutPlan;
    if (state.activeWorkoutDayId && plan) {
      const day = plan.days.find(item => item.workoutDayId === state.activeWorkoutDayId);
      if (day) return renderWorkoutSession(day, plan);
      state.activeWorkoutDayId = null;
    }
    return `
      <section class="page-head"><p class="eyebrow">TRAINING</p><h1>Your program</h1><p class="muted">Every movement includes your coach-approved demo and exact targets.</p></section>
      ${plan ? `
        <article class="card card--gold"><div class="spread"><div><p class="eyebrow">ACTIVE PLAN</p><h2>${escapeHtml(plan.title)}</h2><p class="muted">${escapeHtml(plan.summary)}</p></div>${statusChip(plan.status)}</div></article>
        <div class="section-head"><h2>Training days</h2><span class="caption">${plan.days.length} sessions</span></div>
        <div class="stack">${plan.days.map(day => `
          <article class="workout-day"><div class="day-number">${day.dayIndex}</div><div><h3>${escapeHtml(day.title)}</h3><p>${day.exercises.length} exercises · ${day.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0)} sets</p></div><button class="button button--small" type="button" data-action="open-workout" data-day-id="${day.workoutDayId}">Open</button></article>`).join('')}</div>`
        : emptyState('◫', 'Program coming soon', 'Your coach has not published a workout plan yet. You will see it here as soon as it is ready.')}`;
  }

  function videoUrl(exercise) {
    try {
      const url = new URL(exercise.videoUrl);
      const host = url.hostname.replace(/^www\./, '');
      if (exercise.videoKind === 'youtube') {
        const id = host === 'youtu.be' ? url.pathname.split('/').filter(Boolean)[0] : (url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1));
        return { kind: 'iframe', url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` };
      }
      if (exercise.videoKind === 'vimeo') {
        const id = url.pathname.split('/').filter(Boolean).find(part => /^\d+$/.test(part));
        return { kind: 'iframe', url: `https://player.vimeo.com/video/${encodeURIComponent(id)}` };
      }
      if (exercise.videoKind === 'video') return { kind: 'video', url: exercise.videoUrl };
      return { kind: 'link', url: exercise.videoUrl };
    } catch { return { kind: 'link', url: exercise.videoUrl }; }
  }

  function renderVideo(exercise) {
    const video = videoUrl(exercise);
    const safe = escapeHtml(video.url);
    if (video.kind === 'iframe') return `<iframe class="video-frame" src="${safe}" title="${escapeHtml(exercise.name)} demonstration" loading="lazy" allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    if (video.kind === 'video') return `<video class="video-frame" src="${safe}" controls playsinline preload="metadata"></video>`;
    return `<a class="video-link" href="${safe}" target="_blank" rel="noopener noreferrer">▶ Open exercise demo</a>`;
  }

  function renderWorkoutSession(day, plan) {
    return `
      <section class="page-head"><button class="button button--ghost button--small" type="button" data-action="back-workouts">← Program</button><p class="eyebrow" style="margin-top:22px">${escapeHtml(plan.title)}</p><h1>${escapeHtml(day.title)}</h1><p class="muted">${escapeHtml(day.instructions)}</p></section>
      <form id="workout-log-form" data-form="workout-log" data-day-id="${day.workoutDayId}" class="stack">
        ${day.exercises.map((exercise, exerciseIndex) => `
          <article class="card exercise-card" data-exercise-log="${exercise.workoutExerciseId}">
            ${renderVideo(exercise)}
            <div class="exercise-body"><p class="eyebrow">EXERCISE ${exerciseIndex + 1}</p><h3>${escapeHtml(exercise.name)}</h3><p>${escapeHtml(exercise.instructions)}</p>
              <table class="set-table"><thead><tr><th>Set</th><th>Target</th><th>Weight</th><th>Reps</th><th>Done</th></tr></thead><tbody>
                ${exercise.sets.map((set, setIndex) => `<tr data-set-log><td>${setIndex + 1}</td><td>${escapeHtml(set.reps)}${set.rpe ? ` @ RPE ${set.rpe}` : ''}</td><td><input name="weight" inputmode="decimal" aria-label="Set ${setIndex + 1} weight"></td><td><input name="reps" inputmode="numeric" aria-label="Set ${setIndex + 1} completed reps"></td><td><input name="completed" type="checkbox" aria-label="Set ${setIndex + 1} complete"></td></tr>`).join('')}
              </tbody></table>
            </div>
          </article>`).join('')}
        <article class="card"><div class="form-grid"><label>Session effort (1–10)<input name="effort" type="number" min="1" max="10" inputmode="numeric"></label><label class="wide">Coach feedback<textarea name="feedback" placeholder="Wins, pain, technique questions, or anything your coach should adjust"></textarea></label></div></article>
        <button class="button button--gold" type="submit">Complete workout</button>
      </form>`;
  }

  function renderCarePlan() {
    const dashboard = state.dashboard;
    const tabs = [['nutrition', 'Nutrition'], ['supplements', 'Supplements'], ['protocol', 'Protocol']];
    let content = '';
    if (state.careTab === 'nutrition') content = nutritionCard(dashboard.nutrition);
    if (state.careTab === 'supplements') content = supplementCard(dashboard.supplements);
    if (state.careTab === 'protocol') content = protocolCard(dashboard.protocol);
    return `
      <section class="page-head"><p class="eyebrow">YOUR PLAN</p><h1>Fuel and support</h1><p class="muted">Only the current plan published by your coach is shown here.</p></section>
      <div class="tabs">${tabs.map(([id, label]) => `<button class="tab-button ${state.careTab === id ? 'active' : ''}" type="button" data-action="care-tab" data-tab="${id}">${label}</button>`).join('')}</div>
      <div style="margin-top:16px">${content}</div>`;
  }

  function nutritionCard(plan) {
    if (!plan) return emptyState('◎', 'Nutrition plan pending', 'Your coach will publish your targets and meal framework here.');
    return `<article class="card card--gold"><div class="spread"><div><p class="eyebrow">CURRENT NUTRITION</p><h2>${escapeHtml(plan.title)}</h2></div>${statusChip(plan.status)}</div>
      <div class="macro-grid" style="margin:20px 0"><div class="macro"><strong>${plan.calorieTarget ?? '—'}</strong><span>CALORIES</span></div><div class="macro"><strong>${plan.proteinGrams ?? '—'}g</strong><span>PROTEIN</span></div><div class="macro"><strong>${plan.carbohydrateGrams ?? '—'}g</strong><span>CARBS</span></div><div class="macro"><strong>${plan.fatGrams ?? '—'}g</strong><span>FAT</span></div></div>
      <p class="muted">${lines(plan.guidance)}</p>
      ${plan.meals?.length ? `<div class="section-head"><h3>Meal framework</h3></div><div class="plan-list">${plan.meals.map(meal => `<div class="plan-item"><div><strong>${escapeHtml(meal.name)}</strong><p>${escapeHtml(meal.description)}</p></div><span class="caption">${meal.calories ? `${meal.calories} cal` : ''}</span></div>`).join('')}</div>` : ''}
      <div class="disclaimer" style="margin-top:18px">Nutrition coaching is educational and does not replace individualized medical nutrition therapy. Discuss allergies, conditions, pregnancy, or medication interactions with a licensed professional.</div></article>`;
  }

  function supplementCard(plan) {
    if (!plan) return emptyState('◌', 'Supplement plan pending', 'Your coach will publish your approved supplement list here.');
    return `<article class="card"><div class="spread"><div><p class="eyebrow">CURRENT SUPPLEMENTS</p><h2>${escapeHtml(plan.title)}</h2></div>${statusChip(plan.status)}</div>
      <div class="plan-list">${plan.items.map(item => `<div class="plan-item"><div><strong>${escapeHtml(item.name)}${item.amount ? ` · ${escapeHtml(item.amount)}` : ''}</strong><p>${escapeHtml([item.timing, item.notes].filter(Boolean).join(' — '))}</p></div></div>`).join('')}</div>
      ${plan.notes ? `<p class="muted" style="margin-top:18px">${lines(plan.notes)}</p>` : ''}
      <div class="disclaimer" style="margin-top:18px">Confirm supplements with your licensed clinician or pharmacist, especially if you use medications, have a condition, are pregnant, or experience a reaction.</div></article>`;
  }

  function protocolCard(plan) {
    if (!plan) return emptyState('◇', 'No confirmed protocol', 'A peptide protocol appears only after a licensed clinician confirms the instructions. This app does not create or change peptide dosing.');
    return `<article class="card card--gold"><div class="spread"><div><p class="eyebrow">CLINICIAN-CONFIRMED</p><h2>${escapeHtml(plan.title)}</h2><p class="caption">Confirmed by ${escapeHtml(plan.clinicianName)}</p></div>${statusChip(plan.status)}</div>
      <div class="plan-list" style="margin-top:18px">${plan.items.map(item => `<div class="plan-item"><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.instructions)}${item.schedule ? ` · ${escapeHtml(item.schedule)}` : ''}${item.notes ? ` — ${escapeHtml(item.notes)}` : ''}</p></div></div>`).join('')}</div>
      ${plan.notes ? `<p class="muted" style="margin-top:18px">${lines(plan.notes)}</p>` : ''}
      <div class="disclaimer" style="margin-top:18px">Display-only record of instructions confirmed by the named licensed clinician. Lion Elite Coaching does not diagnose, prescribe, generate dosing, or replace medical care. Contact the clinician before changing anything.</div></article>`;
  }

  function renderMessages(role) {
    const messages = role === 'coach' ? (state.selected?.dashboard?.messages || []) : (state.dashboard.messages || []);
    const mine = role === 'coach' ? 'coach' : 'client';
    return `
      <section class="page-head"><p class="eyebrow">DIRECT MESSAGE</p><h1>${role === 'coach' ? escapeHtml(state.selected?.client?.firstName || 'Client') : 'Coach Alex'}</h1><p class="muted">Private coaching conversation. For emergencies, call emergency services—not this chat.</p></section>
      <div id="message-list" class="message-list">${messages.length ? messages.map(message => `<article class="message ${message.senderType === mine ? 'message--mine' : ''}"><strong>${escapeHtml(message.senderName)}</strong><p>${escapeHtml(message.body)}</p><time>${formatDate(message.createdAt)} · ${formatTime(message.createdAt)}</time></article>`).join('') : emptyState('✦', 'Start the conversation', role === 'coach' ? 'Send a clear next step or check in with this client.' : 'Ask a question, share a win, or tell your coach what needs attention.')}</div>
      <form class="message-composer" data-form="${role === 'coach' ? 'coach-message' : 'client-message'}"><textarea name="body" maxlength="2000" required placeholder="Write a message…" aria-label="Message"></textarea><button class="button button--gold" type="submit">Send</button></form>`;
  }

  function renderProgress() {
    const checkins = state.dashboard.checkins;
    const logs = state.dashboard.workoutLogs.filter(log => log.status === 'completed');
    return `
      <section class="page-head"><p class="eyebrow">PROGRESS</p><h1>Stay honest. Adjust fast.</h1><p class="muted">Your check-ins give your coach the context to make smarter changes.</p></section>
      <article class="card card--gold"><h2>New check-in</h2><form class="stack-form" data-form="checkin"><div class="form-grid"><label>Weight (lb)<input name="weightLbs" type="number" min="50" max="1000" step="0.1" inputmode="decimal"></label><label>Sleep (hours)<input name="sleepHours" type="number" min="0" max="24" step="0.1" inputmode="decimal"></label><label>Energy (1–10)<input name="energy" type="number" min="1" max="10" inputmode="numeric"></label><label>Plan adherence (1–10)<input name="adherence" type="number" min="1" max="10" inputmode="numeric"></label><label>Soreness (1–10)<input name="soreness" type="number" min="1" max="10" inputmode="numeric"></label><label class="wide">What should your coach know?<textarea name="notes" maxlength="3000" placeholder="Wins, hunger, pain, stress, schedule changes…"></textarea></label></div><button class="button button--gold" type="submit">Submit check-in</button></form></article>
      <div class="section-head"><h2>History</h2><span class="caption">${logs.length} workouts completed</span></div>
      ${checkins.length ? `<div class="stack">${checkins.map(checkin => `<article class="card"><div class="spread"><strong>${formatDate(checkin.createdAt, { year: 'numeric' })}</strong><span class="caption">${checkin.weightLbs ? `${checkin.weightLbs} lb` : 'No weight'}</span></div><div class="macro-grid" style="margin-top:14px"><div class="macro"><strong>${checkin.sleepHours ?? '—'}</strong><span>SLEEP</span></div><div class="macro"><strong>${checkin.energy ?? '—'}</strong><span>ENERGY</span></div><div class="macro"><strong>${checkin.adherence ?? '—'}</strong><span>ADHERENCE</span></div><div class="macro"><strong>${checkin.soreness ?? '—'}</strong><span>SORENESS</span></div></div>${checkin.notes ? `<p class="muted" style="margin-top:14px">${escapeHtml(checkin.notes)}</p>` : ''}</article>`).join('')}</div>` : emptyState('↗', 'No check-ins yet', 'Submit your first check-in above to start building your progress history.')}`;
  }

  function renderProfile() {
    const client = state.dashboard.client;
    const profile = client.profile || {};
    const onboarding = !profileReady(client);
    const equipment = Array.isArray(profile.equipment) ? profile.equipment.join(', ') : '';
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return `<section class="page-head"><p class="eyebrow">${onboarding ? 'CLIENT ONBOARDING' : 'PROFILE'}</p><h1>${onboarding ? `Welcome, ${escapeHtml(client.firstName)}.` : `${escapeHtml(client.firstName)} ${escapeHtml(client.lastName)}`}</h1><p class="muted">${onboarding ? 'Tell your coach what matters before your program is built. You can update this later.' : escapeHtml(client.email)}</p></section>
      <div class="stack">${onboarding ? '<article class="card card--gold"><p class="eyebrow">STEP 1 OF 1</p><h2>Build your coaching baseline</h2><p class="muted">This takes about two minutes and gives your coach the context needed to personalize training and check-ins.</p></article>' : ''}
      <article class="card"><div class="spread"><div><p class="eyebrow">COACHING INTAKE</p><h2>${onboarding ? 'Complete your profile' : 'Update your profile'}</h2></div>${profileReady(client) ? '<span class="status-chip status-chip--ready">Complete</span>' : '<span class="status-chip status-chip--pending">Required</span>'}</div>
        <form class="stack-form" data-form="client-profile"><div class="form-grid">
          <label class="wide">Primary goal<input name="goal" required maxlength="500" value="${escapeHtml(profile.goal || '')}" placeholder="Build strength, lose body fat, improve consistency…"></label>
          <label>Experience level<select name="experienceLevel"><option value="beginner" ${profile.experienceLevel === 'beginner' ? 'selected' : ''}>Beginner</option><option value="intermediate" ${profile.experienceLevel !== 'beginner' && profile.experienceLevel !== 'advanced' ? 'selected' : ''}>Intermediate</option><option value="advanced" ${profile.experienceLevel === 'advanced' ? 'selected' : ''}>Advanced</option></select></label>
          <label>Training days/week<input name="daysPerWeek" type="number" min="1" max="7" required value="${profile.daysPerWeek || 3}"></label>
          <label>Session minutes<input name="sessionMinutes" type="number" min="20" max="180" required value="${profile.sessionMinutes || 60}"></label>
          <label>Typical sleep (hours)<input name="typicalSleepHours" type="number" min="0" max="24" step="0.1" value="${profile.typicalSleepHours ?? ''}"></label>
          <label>Preferred check-in day<select name="preferredCheckInDay"><option value="">No preference</option>${days.map(day => `<option value="${day}" ${profile.preferredCheckInDay === day ? 'selected' : ''}>${day}</option>`).join('')}</select></label>
          <label class="wide">Available equipment<input name="equipment" value="${escapeHtml(equipment)}" placeholder="barbell, dumbbell, cable, bodyweight"></label>
          <label class="wide">Limitations, injuries, or movements to avoid<textarea name="limitations" maxlength="1500" placeholder="Tell your coach what needs modification. Contact a clinician for new or serious symptoms.">${escapeHtml(profile.limitations || '')}</textarea></label>
          <label class="wide">Dietary preferences<textarea name="dietaryPreferences" maxlength="1000" placeholder="Foods, schedule, cultural preferences, or eating style">${escapeHtml(profile.dietaryPreferences || '')}</textarea></label>
          <label class="wide">Allergies or intolerances<textarea name="allergies" maxlength="1000" placeholder="List known food or supplement allergies">${escapeHtml(profile.allergies || '')}</textarea></label>
          <label class="wide">Biggest obstacle right now<textarea name="primaryObstacle" maxlength="1500" placeholder="Sleep, schedule, motivation, pain, travel, consistency…">${escapeHtml(profile.primaryObstacle || '')}</textarea></label>
          <label class="checkbox wide"><input name="coachingAcknowledged" type="checkbox" required ${profile.coachingAcknowledgedAt ? 'checked' : ''}><span>I understand this portal provides coaching—not emergency or medical care—and I will discuss symptoms, conditions, medications, and protocol changes with a licensed clinician.</span></label>
        </div><button class="button button--gold" type="submit">${onboarding ? 'Complete onboarding' : 'Save profile'}</button></form>
      </article>
      <article class="card"><h3>Put Lion Elite on your phone</h3><p class="muted">Install this private portal like an app—no App Store required.</p><button class="button button--gold" type="button" data-action="install">Install app</button></article>
      <article class="card"><h3>Message alerts</h3><p class="muted">Get a private notification when your coach writes back. Message content is never shown in the lock-screen alert.</p><button class="button" type="button" data-action="notifications">Enable alerts</button></article>
      <button class="button button--danger" type="button" data-action="logout">Sign out</button></div>`;
  }

  function renderCoachSidebar() {
    if (state.actor?.actorType !== 'coach') return;
    elements.sidebar.innerHTML = `
      <nav class="coach-nav" aria-label="Coach tools">${navForCoach().map(([view, label, icon]) => `<button type="button" class="${state.currentView === view ? 'active' : ''}" data-view="${view}"><span>${icon}</span>${label}</button>`).join('')}</nav>
      <div class="sidebar-title"><p class="eyebrow">CLIENTS</p><button class="icon-button" type="button" data-view="coach-clients" title="New client">＋</button></div>
      <div class="client-list">${state.clients.map(client => `<button class="client-row ${state.selectedClientId === client.clientId ? 'active' : ''}" type="button" data-action="select-client" data-client-id="${client.clientId}"><span class="avatar">${initials(client.firstName, client.lastName)}</span><span><strong>${escapeHtml(client.firstName)} ${escapeHtml(client.lastName)}</strong><small>${escapeHtml(client.profile?.goal || client.email)}</small></span>${client.unreadCount ? `<span class="unread">${client.unreadCount}</span>` : ''}</button>`).join('')}</div>`;
  }

  function renderCoachView() {
    const renders = {
      'coach-clients': renderCoachClients,
      'coach-workouts': renderCoachWorkouts,
      'coach-care': renderCoachCare,
      'coach-messages': () => state.selected ? renderMessages('coach') : selectClientPrompt(),
      'coach-library': renderExerciseLibrary,
      'coach-leads': renderLeads,
      'coach-coaches': renderCoaches
    };
    elements.main.innerHTML = (renders[state.currentView] || renderCoachClients)();
    if (state.currentView === 'coach-messages') scrollMessages();
  }

  function selectClientPrompt() {
    return `<section class="page-head"><p class="eyebrow">COACH PORTAL</p><h1>Select a client</h1></section>${emptyState('◉', 'No client selected', 'Choose a client from the list to continue.')}`;
  }

  function renderCoachClients() {
    const selected = state.selected;
    const latest = selected?.dashboard?.checkins?.[0];
    const onboardingComplete = profileReady(selected?.client);
    const publishedWorkout = selected?.workoutPlans?.some(plan => plan.status === 'published');
    return `
      <section class="page-head"><p class="eyebrow">COACH COMMAND CENTER</p><h1>${selected ? `${escapeHtml(selected.client.firstName)} ${escapeHtml(selected.client.lastName)}` : 'Your client roster'}</h1><p class="muted">Invite, program, communicate, and adjust from one place.</p></section>
      <article class="card launch-card"><div class="spread"><div><p class="eyebrow">LAUNCH CHECKLIST</p><h3>Get the first client live</h3></div><span class="caption">${[state.clients.length > 0, state.exercises.length >= 3, onboardingComplete, publishedWorkout].filter(Boolean).length}/4 ready</span></div><div class="checklist"><div class="checklist-item ${state.clients.length ? 'complete' : ''}"><i>${state.clients.length ? '✓' : '1'}</i><span>Create client</span></div><div class="checklist-item ${state.exercises.length >= 3 ? 'complete' : ''}"><i>${state.exercises.length >= 3 ? '✓' : '2'}</i><span>Add 3 videos</span></div><div class="checklist-item ${onboardingComplete ? 'complete' : ''}"><i>${onboardingComplete ? '✓' : '3'}</i><span>Client intake</span></div><div class="checklist-item ${publishedWorkout ? 'complete' : ''}"><i>${publishedWorkout ? '✓' : '4'}</i><span>Publish workout</span></div></div></article>
      ${selected ? `<div class="card-grid"><article class="card card--gold wide"><div class="spread"><div><p class="eyebrow">${escapeHtml(selected.client.status).toUpperCase()} CLIENT</p><h2>${escapeHtml(selected.client.profile?.goal || 'Goal not set')}</h2><p class="muted">${escapeHtml(selected.client.email)} · ${selected.client.profile?.daysPerWeek || 3} training days</p></div><span class="avatar">${initials(selected.client.firstName, selected.client.lastName)}</span></div><div class="cluster"><button class="button button--gold button--small" type="button" data-action="create-invite">Create app link</button><button class="button button--small" type="button" data-view="coach-workouts">Build workout</button><button class="button button--small" type="button" data-view="coach-messages">Message</button></div></article>
        <article class="card metric"><span>Latest weight</span><strong>${latest?.weightLbs ? `${latest.weightLbs} lb` : '—'}</strong><small class="caption">${formatDate(latest?.createdAt)}</small></article>
        <article class="card metric"><span>Energy</span><strong>${latest?.energy ? `${latest.energy}/10` : '—'}</strong><small class="caption">Latest check-in</small></article>
        <article class="card metric"><span>Client intake</span><strong>${onboardingComplete ? 'Ready' : 'Pending'}</strong><small class="caption">${onboardingComplete ? `Updated ${formatDate(selected.client.profile.updatedByClientAt || selected.client.profile.onboardingCompletedAt)}` : 'Send the private app link'}</small></article></div>
        ${state.lastInvite ? `<article class="card" style="margin-top:14px"><p class="eyebrow">PRIVATE INSTALL LINK · EXPIRES ${formatDate(state.lastInvite.expiresAt)}</p><div class="cluster"><input id="invite-link" readonly value="${escapeHtml(state.lastInvite.url)}"><button class="button button--gold" type="button" data-action="copy-invite">Copy</button></div></article>` : ''}` : ''}
      <div class="section-head"><h2>Add a client</h2><span class="caption">Creates a private profile first</span></div>
      <article class="card"><form class="stack-form" data-form="create-client"><div class="form-grid"><label>First name<input name="firstName" required maxlength="80"></label><label>Last name<input name="lastName" maxlength="80"></label><label class="wide">Email<input name="email" type="email" required autocomplete="email"></label><label class="wide">Primary goal<input name="goal" maxlength="500" placeholder="Lean six-pack, strength, consistency…"></label><label>Training days/week<input name="daysPerWeek" type="number" min="1" max="7" value="3"></label><label>Session minutes<input name="sessionMinutes" type="number" min="20" max="180" value="60"></label><label class="wide">Available equipment<input name="equipment" placeholder="barbell, dumbbell, cable, bodyweight"></label><label class="wide">Limitations / injuries<textarea name="limitations" maxlength="1500"></textarea></label></div><button class="button button--gold" type="submit">Create client and app link</button></form></article>`;
  }

  function renderCoachWorkouts() {
    if (!state.selected) return selectClientPrompt();
    const client = state.selected.client;
    const plans = state.selected.workoutPlans || [];
    return `<section class="page-head"><p class="eyebrow">WORKOUT BUILDER · ${escapeHtml(client.firstName).toUpperCase()}</p><h1>Program with video built in.</h1><p class="muted">The assistant can only choose exercises from your approved video library. Every result stays in draft until you publish it.</p></section>
      <article class="card card--gold"><div class="spread"><div><h2>Assisted first draft</h2><p class="muted">Goal: ${escapeHtml(client.profile?.goal || 'general fitness')} · ${client.profile?.daysPerWeek || 3} days · ${client.profile?.sessionMinutes || 60} minutes</p></div><span class="status-chip">${state.exercises.length} videos</span></div>
        <form class="stack-form" data-form="workout-draft"><div class="form-grid"><label>Training days<input name="daysPerWeek" type="number" min="1" max="7" value="${client.profile?.daysPerWeek || 3}"></label><label>Session minutes<input name="sessionMinutes" type="number" min="20" max="180" value="${client.profile?.sessionMinutes || 60}"></label><label class="wide">Goal<input name="goal" value="${escapeHtml(client.profile?.goal || '')}" required></label><label class="wide">Limitations<textarea name="limitations">${escapeHtml(client.profile?.limitations || '')}</textarea></label></div><button class="button button--gold" type="submit">Generate coach-review draft</button></form>
        ${state.exercises.length < 3 ? '<div class="disclaimer" style="margin-top:14px">Add at least three exercise videos in the Video Library before generating a plan.</div>' : ''}</article>
      <div class="section-head"><h2>Plans</h2><span class="caption">${plans.length} total</span></div>
      ${plans.length ? `<div class="stack">${plans.map(plan => `<article class="card"><div class="spread"><div><p class="eyebrow">${escapeHtml(plan.source).toUpperCase()}</p><h3>${escapeHtml(plan.title)}</h3><p class="muted">${plan.days.length} days · ${plan.days.reduce((sum, day) => sum + day.exercises.length, 0)} video exercises</p></div>${statusChip(plan.status)}</div>${plan.status === 'draft' ? `<button class="button button--gold button--small" type="button" data-action="publish-workout" data-plan-id="${plan.planId}">Review complete—publish</button>` : ''}</article>`).join('')}</div>` : emptyState('◫', 'No workout plan yet', 'Generate a video-backed draft above, then review and publish it to the client.')}`;
  }

  function renderCoachCare() {
    if (!state.selected) return selectClientPrompt();
    const client = state.selected.client;
    return `<section class="page-head"><p class="eyebrow">CARE PLANS · ${escapeHtml(client.firstName).toUpperCase()}</p><h1>One clear source of truth.</h1><p class="muted">Publishing replaces the client’s current view while preserving prior plans in history.</p></section>
      <div class="card-grid">
        <article class="card full"><p class="eyebrow">NUTRITION</p><h2>Nutrition framework</h2><form class="stack-form" data-form="nutrition-plan"><div class="form-grid"><label class="wide">Plan title<input name="title" required placeholder="Cut Phase · Week 1–4"></label><label>Calories<input name="calorieTarget" type="number" min="500" max="10000"></label><label>Protein (g)<input name="proteinGrams" type="number" min="0" max="1000"></label><label>Carbs (g)<input name="carbohydrateGrams" type="number" min="0" max="1500"></label><label>Fat (g)<input name="fatGrams" type="number" min="0" max="500"></label><label class="wide">Guidance<textarea name="guidance" maxlength="4000"></textarea></label><label class="wide">Meals — one per line: name | description | calories<textarea name="meals" placeholder="Breakfast | Eggs, oats, fruit | 550"></textarea></label></div><button class="button button--gold" type="submit">Save and publish nutrition</button></form></article>
        <article class="card full"><p class="eyebrow">SUPPLEMENTS</p><h2>Supplement list</h2><form class="stack-form" data-form="supplement-plan"><label>Plan title<input name="title" required placeholder="Daily fundamentals"></label><label>One per line: name | amount | timing | notes<textarea name="items" required placeholder="Omega-3 | label-directed | with a meal | Confirm with clinician"></textarea></label><label>Plan notes<textarea name="notes"></textarea></label><button class="button button--gold" type="submit">Save and publish supplements</button></form></article>
        <article class="card card--gold full"><p class="eyebrow">DISPLAY-ONLY MEDICAL RECORD</p><h2>Peptide protocol</h2><p class="muted">The app never generates dosing. Publish only instructions already confirmed by the client’s licensed clinician.</p><form class="stack-form" data-form="protocol-plan"><div class="form-grid"><label>Protocol title<input name="title" required></label><label>Licensed clinician<input name="clinicianName" required></label><label>Licence type<input name="clinicianLicenseType" required placeholder="MD, DO, NP, PA"></label><label>Licence number<input name="clinicianLicenseNumber" required></label><label>Licence state<input name="clinicianLicenseState" required placeholder="OH"></label><label>Licence expiry<input name="clinicianLicenseExpiresAt" type="date"></label><label>NPI (optional)<input name="clinicianNpi"></label><label>Client consent obtained<input name="consentObtainedAt" type="date" required></label><label>Consent document ID (optional)<input name="consentDocumentId"></label><label class="wide">One per line: name | exact clinician instruction | schedule | notes<textarea name="items" required></textarea></label><label class="wide">Notes<textarea name="notes"></textarea></label><label class="checkbox wide"><input name="clinicianConfirmed" type="checkbox" required><span>I confirm these instructions came from the named licensed clinician, that I have verified the licence details above, and that they were not generated by this app.</span></label></div><button class="button button--gold" type="submit">Save and publish confirmed protocol</button></form></article>
      </div>`;
  }

  function renderExerciseLibrary() {
    return `<section class="page-head"><p class="eyebrow">EXERCISE VIDEO LIBRARY</p><h1>Every assignment demonstrates itself.</h1><p class="muted">Use your own hosted video, an unlisted YouTube/Vimeo link, or a direct HTTPS video file. A workout cannot publish without video coverage.</p></section>
      <article class="card card--gold"><h2>Add exercise</h2><form class="stack-form" data-form="create-exercise"><div class="form-grid"><label>Exercise name<input name="name" required></label><label>Muscle group<input name="muscleGroup" placeholder="chest"></label><label>Equipment<input name="equipment" placeholder="barbell"></label><label>Video URL<input name="videoUrl" type="url" required placeholder="https://…"></label><label class="wide">Coaching cues<textarea name="instructions" maxlength="2000"></textarea></label></div><button class="button button--gold" type="submit">Add video exercise</button></form></article>
      <div class="section-head"><h2>Approved library</h2><span class="caption">${state.exercises.length} exercises</span></div>
      ${state.exercises.length ? `<div class="card-grid">${state.exercises.map(exercise => `<article class="card"><p class="eyebrow">${escapeHtml(exercise.muscleGroup)}</p><h3>${escapeHtml(exercise.name)}</h3><p class="muted">${escapeHtml(exercise.equipment)} · ${escapeHtml(exercise.videoKind)}</p><a href="${escapeHtml(exercise.videoUrl)}" target="_blank" rel="noopener noreferrer">Preview video ↗</a></article>`).join('')}</div>` : emptyState('▶', 'No exercise videos yet', 'Add at least three approved videos to unlock assisted workout drafts.')}`;
  }

  function renderLeads() {
    const data = state.leads;
    if (!data) return `<section class="page-head"><p class="eyebrow">LEAD FLOW</p><h1>Loading leads…</h1></section>`;

    const { totals, sources, recent, flowing } = data;
    const when = value => value ? formatDate(value, { month: 'short', day: 'numeric' }) : '—';

    return `<section class="page-head"><p class="eyebrow">LEAD FLOW</p>
      <h1>${flowing ? `${totals.last24h} new in the last 24 hours.` : 'Nothing has arrived in 24 hours.'}</h1>
      <p class="muted">${totals.total} total across every source · ${totals.last7d} this week.
      ${flowing ? '' : 'If that is unexpected, check that the listener and discovery worker are running.'}</p></section>

      <div class="card-grid">
        ${sources.length ? sources.map(source => `
          <article class="card">
            <p class="eyebrow">${escapeHtml(source.label)}</p>
            <h2>${source.total}</h2>
            <p class="muted">${source.last24h} today · ${source.last7d} this week · last ${when(source.newest)}</p>
            ${source.smsReachable !== undefined
              ? `<p class="caption">${source.emailReachable} emailable · ${source.smsReachable} textable${source.unsubscribed ? ` · ${source.unsubscribed} unsubscribed` : ''}</p>`
              : `<p class="caption">${source.averageScore === null ? 'unscored' : `avg score ${source.averageScore}`}</p>`}
          </article>`).join('')
          : emptyState('◈', 'No leads yet', 'Nothing has been captured or discovered so far.')}
      </div>

      <div class="section-head"><h2>Most recent</h2><span class="caption">${recent.length} shown</span></div>
      ${recent.length ? `<div class="stack">${recent.map(lead => `
        <article class="card">
          <div class="spread">
            <div>
              <p class="eyebrow">${escapeHtml(lead.source)}${lead.score !== null && lead.score !== undefined ? ` · SCORE ${lead.score}` : ''}</p>
              <h3>${escapeHtml(lead.name)}</h3>
              <p class="muted">${[lead.detail, lead.email, lead.phone].filter(Boolean).map(escapeHtml).join(' · ') || 'No contact details'}</p>
              ${lead.consent?.length ? `<p class="caption">Consented: ${lead.consent.join(', ')}</p>` : ''}
            </div>
            <span class="caption">${when(lead.createdAt)}</span>
          </div>
          ${lead.link ? `<div class="cluster"><a class="button button--small" href="${escapeHtml(lead.link)}" target="_blank" rel="noopener noreferrer">Open</a></div>` : ''}
        </article>`).join('')}</div>`
        : emptyState('◈', 'Nothing yet', 'Leads will appear here as the engines find them.')}`;
  }

  function renderCoaches() {
    const coaches = state.coaches || [];
    // The plaintext token exists only in this response; it is never stored and
    // cannot be read back, so it is shown until the owner navigates away.
    const issued = state.lastCoachToken;
    return `<section class="page-head"><p class="eyebrow">COACH ACCOUNTS</p><h1>Who can coach on this platform.</h1><p class="muted">Each coach signs in with their own access token and sees only the clients assigned to them. You see everyone.</p></section>
      <article class="card card--gold"><h2>Add a coach</h2><form class="stack-form" data-form="create-coach"><div class="form-grid"><label>Full name<input name="name" required placeholder="Jordan Blake"></label><label>Email<input name="email" type="email" required placeholder="jordan@example.com"></label></div><button class="button button--gold" type="submit">Create coach account</button></form></article>
      ${issued ? `<article class="card" style="margin-top:14px"><p class="eyebrow">ACCESS TOKEN FOR ${escapeHtml(issued.name)} · SHOWN ONCE</p><p class="muted">Send this to them privately. It cannot be displayed again — if it is lost, rotate it below.</p><div class="cluster"><input id="coach-token" readonly value="${escapeHtml(issued.accessToken)}"><button class="button button--gold" type="button" data-action="copy-coach-token">Copy</button></div></article>` : ''}
      <div class="section-head"><h2>Coaches</h2><span class="caption">${coaches.length} account${coaches.length === 1 ? '' : 's'}</span></div>
      ${coaches.length ? `<div class="stack">${coaches.map(coach => `<article class="card"><div class="spread"><div><p class="eyebrow">${escapeHtml(coach.role).toUpperCase()}${coach.status === 'suspended' ? ' · SUSPENDED' : ''}</p><h3>${escapeHtml(coach.name)}</h3><p class="muted">${escapeHtml(coach.email)} · ${coach.clientCount} client${coach.clientCount === 1 ? '' : 's'}</p></div>${statusChip(coach.status === 'active' ? 'active' : 'paused')}</div>
        ${coach.role === 'owner' ? '<p class="caption">The owner account cannot be suspended from here.</p>' : `<div class="cluster"><button class="button button--small" type="button" data-action="rotate-coach-token" data-coach-id="${coach.coachId}" data-coach-name="${escapeHtml(coach.name)}">Rotate token</button><button class="button button--small ${coach.status === 'active' ? 'button--danger' : ''}" type="button" data-action="toggle-coach" data-coach-id="${coach.coachId}" data-next="${coach.status === 'active' ? 'suspended' : 'active'}">${coach.status === 'active' ? 'Suspend' : 'Reactivate'}</button></div>`}
      </article>`).join('')}</div>` : emptyState('⚑', 'No other coaches yet', 'Add a coach to give them their own client roster.')}`;
  }

  function scrollMessages() {
    requestAnimationFrame(() => {
      const list = document.querySelector('#message-list');
      if (list) list.scrollTop = list.scrollHeight;
    });
  }

  function connectMessageStream() {
    state.eventSource?.close();
    if (!state.actor) return;
    const suffix = state.actor.actorType === 'coach' ? `?clientId=${encodeURIComponent(state.selectedClientId || '')}` : '';
    if (state.actor.actorType === 'coach' && !state.selectedClientId) return;
    const source = new EventSource(`${API}/messages/stream${suffix}`);
    state.eventSource = source;
    source.addEventListener('open', () => elements.livePill.classList.remove('hidden'));
    source.addEventListener('error', () => elements.livePill.classList.add('hidden'));
    source.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const target = state.actor.actorType === 'coach' ? state.selected?.dashboard?.messages : state.dashboard?.messages;
      if (target && !target.some(item => item.messageId === message.messageId)) target.push(message);
      if (state.currentView === 'messages' || state.currentView === 'coach-messages') {
        renderView(state.currentView);
      } else {
        toast(`New message from ${message.senderName}`);
      }
    });
  }

  function parseRows(value, fields) {
    return String(value || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split('|').map(part => part.trim());
      return Object.fromEntries(fields.map((field, index) => [field, parts[index] || '']));
    });
  }

  async function handleSubmit(event) {
    const form = event.target.closest('form');
    if (!form) return;
    event.preventDefault();
    const kind = form.dataset.form || form.id;
    const data = Object.fromEntries(new FormData(form));
    setLoading(form, true);
    try {
      if (kind === 'coach-login-form') {
        const response = await api('/auth/coach', { method: 'POST', body: { token: data.token } });
        await enterApp(response.actor);
      } else if (kind === 'create-client') {
        const created = await api('/admin/clients', { method: 'POST', body: { firstName: data.firstName, lastName: data.lastName, email: data.email, profile: { goal: data.goal, daysPerWeek: Number(data.daysPerWeek), sessionMinutes: Number(data.sessionMinutes), equipment: data.equipment.split(',').map(item => item.trim()).filter(Boolean), limitations: data.limitations } } });
        state.selectedClientId = created.client.clientId;
        const invite = await api(`/admin/clients/${created.client.clientId}/invites`, { method: 'POST', body: {} });
        state.lastInvite = invite.invite;
        await loadCoach();
        renderView('coach-clients');
        toast('Client created. Their private app link is ready.');
      } else if (kind === 'create-coach') {
        const created = await api('/admin/coaches', { method: 'POST', body: { name: data.name, email: data.email } });
        state.lastCoachToken = { name: created.coach.name, accessToken: created.accessToken };
        state.coaches = (await api('/admin/coaches')).coaches;
        form.reset();
        renderView('coach-coaches');
        toast('Coach created. Copy their access token now — it is shown once.');
      } else if (kind === 'create-exercise') {
        await api('/admin/exercises', { method: 'POST', body: data });
        const response = await api('/admin/exercises');
        state.exercises = response.exercises;
        form.reset();
        renderView('coach-library');
        toast('Exercise video added.');
      } else if (kind === 'workout-draft') {
        await api(`/admin/clients/${state.selectedClientId}/workout-draft`, { method: 'POST', body: { profile: { goal: data.goal, daysPerWeek: Number(data.daysPerWeek), sessionMinutes: Number(data.sessionMinutes), limitations: data.limitations } } });
        await loadSelectedClient();
        renderView('coach-workouts');
        toast('Draft created. Review it before publishing.');
      } else if (kind === 'nutrition-plan') {
        const created = await api(`/admin/clients/${state.selectedClientId}/nutrition-plans`, { method: 'POST', body: { title: data.title, calorieTarget: data.calorieTarget, proteinGrams: data.proteinGrams, carbohydrateGrams: data.carbohydrateGrams, fatGrams: data.fatGrams, guidance: data.guidance, meals: parseRows(data.meals, ['name', 'description', 'calories']).map(meal => ({ ...meal, calories: meal.calories ? Number(meal.calories) : null })) } });
        await api(`/admin/care-plans/nutrition/${created.plan.nutritionPlanId}/publish`, { method: 'POST', body: {} });
        await loadSelectedClient(); form.reset(); toast('Nutrition plan published.');
      } else if (kind === 'supplement-plan') {
        const created = await api(`/admin/clients/${state.selectedClientId}/supplement-plans`, { method: 'POST', body: { title: data.title, notes: data.notes, items: parseRows(data.items, ['name', 'amount', 'timing', 'notes']) } });
        await api(`/admin/care-plans/supplements/${created.plan.supplementPlanId}/publish`, { method: 'POST', body: {} });
        await loadSelectedClient(); form.reset(); toast('Supplement plan published.');
      } else if (kind === 'protocol-plan') {
        const created = await api(`/admin/clients/${state.selectedClientId}/protocols`, { method: 'POST', body: { title: data.title, clinicianName: data.clinicianName, clinicianConfirmed: form.elements.clinicianConfirmed.checked, clinicianLicenseType: data.clinicianLicenseType, clinicianLicenseNumber: data.clinicianLicenseNumber, clinicianLicenseState: data.clinicianLicenseState, clinicianNpi: data.clinicianNpi, clinicianLicenseExpiresAt: data.clinicianLicenseExpiresAt, consentObtainedAt: data.consentObtainedAt, consentDocumentId: data.consentDocumentId, notes: data.notes, items: parseRows(data.items, ['name', 'instructions', 'schedule', 'notes']) } });
        await api(`/admin/care-plans/protocol/${created.plan.protocolId}/publish`, { method: 'POST', body: {} });
        await loadSelectedClient(); form.reset(); toast('Clinician-confirmed protocol published.');
      } else if (kind === 'client-message') {
        const response = await api('/messages', { method: 'POST', body: { body: data.body } });
        if (!state.dashboard.messages.some(message => message.messageId === response.message.messageId)) state.dashboard.messages.push(response.message);
        form.reset(); renderView('messages');
      } else if (kind === 'coach-message') {
        const response = await api(`/admin/clients/${state.selectedClientId}/messages`, { method: 'POST', body: { body: data.body } });
        if (!state.selected.dashboard.messages.some(message => message.messageId === response.message.messageId)) state.selected.dashboard.messages.push(response.message);
        form.reset(); renderView('coach-messages');
      } else if (kind === 'checkin') {
        await api('/checkins', { method: 'POST', body: data });
        await loadClient(); renderView('progress'); toast('Check-in sent to your coach.');
      } else if (kind === 'client-profile') {
        const wasOnboarding = !profileReady(state.dashboard.client);
        const response = await api('/profile', { method: 'PATCH', body: {
          coachingAcknowledged: form.elements.coachingAcknowledged.checked,
          profile: {
            goal: data.goal,
            experienceLevel: data.experienceLevel,
            daysPerWeek: Number(data.daysPerWeek),
            sessionMinutes: Number(data.sessionMinutes),
            typicalSleepHours: data.typicalSleepHours === '' ? null : Number(data.typicalSleepHours),
            preferredCheckInDay: data.preferredCheckInDay,
            equipment: data.equipment.split(',').map(item => item.trim()).filter(Boolean),
            limitations: data.limitations,
            dietaryPreferences: data.dietaryPreferences,
            allergies: data.allergies,
            primaryObstacle: data.primaryObstacle
          }
        } });
        state.dashboard.client = response.client;
        state.actor.client = response.client;
        if (wasOnboarding) navigate('today'); else renderView('profile');
        toast(wasOnboarding ? 'Onboarding complete. Your coach can build from this.' : 'Profile updated.');
      } else if (kind === 'workout-log') {
        const performance = [...form.querySelectorAll('[data-exercise-log]')].map(exercise => ({
          workoutExerciseId: exercise.dataset.exerciseLog,
          sets: [...exercise.querySelectorAll('[data-set-log]')].map(row => ({ reps: row.querySelector('[name="reps"]').value, weight: row.querySelector('[name="weight"]').value, completed: row.querySelector('[name="completed"]').checked }))
        }));
        await api(`/workout-days/${form.dataset.dayId}/logs`, { method: 'POST', body: { status: 'completed', performance, effort: data.effort, feedback: data.feedback } });
        state.activeWorkoutDayId = null; await loadClient(); renderView('workouts'); toast('Workout logged. Strong work.');
      }
    } catch (error) {
      if (kind === 'coach-login-form') elements.authMessage.textContent = error.message;
      else toast(error.message, 'error');
      if (error.status === 401 && kind !== 'coach-login-form') showAuth('Your session ended. Sign in again.');
    } finally {
      setLoading(form, false);
    }
  }

  async function handleClick(event) {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { navigate(viewButton.dataset.view); return; }
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === 'home') navigate(state.actor?.actorType === 'coach' ? 'coach-clients' : 'today');
      if (action === 'profile') navigate(state.actor?.actorType === 'coach' ? 'coach-clients' : 'profile');
      if (action === 'care-tab') { state.careTab = button.dataset.tab; renderView('plan'); }
      if (action === 'open-workout') { state.activeWorkoutDayId = button.dataset.dayId; navigate('workouts'); }
      if (action === 'back-workouts') { state.activeWorkoutDayId = null; renderView('workouts'); }
      if (action === 'select-client') {
        state.selectedClientId = button.dataset.clientId; state.lastInvite = null; await loadSelectedClient(); renderCoachSidebar(); renderView(state.currentView);
      }
      if (action === 'create-invite') {
        const response = await api(`/admin/clients/${state.selectedClientId}/invites`, { method: 'POST', body: {} }); state.lastInvite = response.invite; renderView('coach-clients'); toast('Fresh private app link created.');
      }
      if (action === 'copy-invite') {
        await navigator.clipboard.writeText(state.lastInvite.url); toast('App link copied.');
      }
      if (action === 'publish-workout') {
        await api(`/admin/workout-plans/${button.dataset.planId}/publish`, { method: 'POST', body: {} }); await loadSelectedClient(); renderView('coach-workouts'); toast('Workout plan is live for the client.');
      }
      if (action === 'copy-coach-token') {
        await navigator.clipboard.writeText(state.lastCoachToken.accessToken); toast('Access token copied.');
      }
      if (action === 'toggle-coach') {
        const next = button.dataset.next;
        await api(`/admin/coaches/${button.dataset.coachId}`, { method: 'PATCH', body: { status: next } });
        state.coaches = (await api('/admin/coaches')).coaches;
        renderView('coach-coaches');
        toast(next === 'suspended' ? 'Coach suspended. Their sessions ended immediately.' : 'Coach reactivated.');
      }
      if (action === 'rotate-coach-token') {
        const response = await api(`/admin/coaches/${button.dataset.coachId}/token`, { method: 'POST', body: {} });
        state.lastCoachToken = { name: button.dataset.coachName, accessToken: response.accessToken };
        state.coaches = (await api('/admin/coaches')).coaches;
        renderView('coach-coaches');
        toast('New token issued. The previous one no longer works.');
      }
      if (action === 'install') await installApp();
      if (action === 'notifications') await enableNotifications();
      if (action === 'close-modal') elements.modal.innerHTML = '';
      if (action === 'logout') {
        await api('/auth/logout', { method: 'POST', body: {} }); location.hash = ''; showAuth('Signed out securely.');
      }
    } catch (error) { toast(error.message, 'error'); }
  }

  async function installApp() {
    if (isStandalone()) return toast('Lion Elite Coaching is already installed.');
    if (state.deferredInstallPrompt) {
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      return;
    }
    const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    elements.modal.innerHTML = `<div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="install-title"><div class="modal"><button class="modal-close" type="button" data-action="close-modal">×</button><p class="eyebrow">NO APP STORE REQUIRED</p><h2 id="install-title">Add Lion Elite to your phone</h2>${isiOS ? '<div class="stack"><p>1. Open this link in <strong>Safari</strong>.</p><p>2. Tap the <strong>Share</strong> button.</p><p>3. Choose <strong>Add to Home Screen</strong>, then tap Add.</p><p>4. Open Lion Elite from the new icon. You can then enable message alerts.</p></div>' : '<p class="muted">Open your browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>'}<button class="button button--gold" type="button" data-action="close-modal">Got it</button></div></div>`;
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(character => character.charCodeAt(0)));
  }

  async function enableNotifications() {
    if (!state.config?.pushConfigured) throw new Error('Message alerts are not configured on the server yet.');
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support app notifications.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.config.pushPublicKey) });
    await api('/push-subscriptions', { method: 'POST', body: subscription.toJSON() });
    toast('Message alerts enabled.');
  }

  async function boot() {
    try {
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/coaching/sw.js', { scope: '/coaching/' }).catch(() => {});
      state.config = await api('/config');
      const fragment = location.hash.startsWith('#invite=') ? location.hash.slice(1) : '';
      // Query parsing remains temporarily for previously issued links; every
      // new invitation uses the referrer-safe URL fragment form.
      const inviteToken = new URLSearchParams(fragment).get('invite') || new URLSearchParams(location.search).get('invite');
      if (inviteToken) {
        const response = await api('/auth/invite', { method: 'POST', body: { token: inviteToken } });
        history.replaceState(null, '', '/coaching/#today');
        await enterApp(response.actor);
        toast('Private app access activated.');
        return;
      }
      const session = await api('/session');
      if (session.actor) await enterApp(session.actor);
      else showAuth();
    } catch (error) {
      showAuth(error.message);
    }
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
  });
  window.addEventListener('appinstalled', () => toast('Lion Elite Coaching installed.'));
  window.addEventListener('hashchange', () => state.actor && renderView(currentHash()));
  document.addEventListener('submit', handleSubmit);
  document.addEventListener('click', handleClick);
  boot();
})();
