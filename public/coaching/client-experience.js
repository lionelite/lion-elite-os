(() => {
  'use strict';

  const API = '/api/coaching';
  let actor = null;
  let dashboard = null;
  let lastView = '';

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  async function api(path) {
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load coaching data.');
    return payload;
  }

  function currentView() {
    return location.hash.replace(/^#/, '') || 'today';
  }

  function planStatus(item) {
    if (!item) return '<span class="le-plan-status le-plan-status--pending">Pending</span>';
    return `<span class="le-plan-status le-plan-status--live">Live</span>`;
  }

  function careHub() {
    if (!dashboard) return '';
    const workout = dashboard.workoutPlan;
    const nutrition = dashboard.nutrition;
    const supplements = dashboard.supplements;
    const protocol = dashboard.protocol;
    const nextWorkout = workout?.days?.[0];
    const supplementCount = supplements?.items?.length || 0;
    const protocolCount = protocol?.items?.length || 0;

    return `
      <section class="le-client-hub" data-client-care-hub>
        <div class="le-client-hub__head">
          <div>
            <p class="eyebrow">YOUR COACHING SYSTEM</p>
            <h2>Everything in one place</h2>
            <p class="muted">Training, nutrition, supplements, and your confirmed care plan stay organized around you.</p>
          </div>
        </div>
        <div class="le-client-hub__grid">
          <button type="button" class="le-client-module le-client-module--training" data-care-destination="workouts">
            <span class="le-client-module__icon">◫</span>
            <span class="le-client-module__body">
              <span class="le-client-module__top"><strong>Training</strong>${planStatus(workout)}</span>
              <small>${nextWorkout ? `${esc(nextWorkout.title)} · ${workout.days.length} sessions` : 'Your coach is building your program.'}</small>
            </span>
            <span class="le-client-module__arrow">→</span>
          </button>
          <button type="button" class="le-client-module" data-care-destination="nutrition">
            <span class="le-client-module__icon">◎</span>
            <span class="le-client-module__body">
              <span class="le-client-module__top"><strong>Nutrition</strong>${planStatus(nutrition)}</span>
              <small>${nutrition?.calorieTarget ? `${nutrition.calorieTarget} calories · ${nutrition.proteinGrams || '—'}g protein` : 'Macros, meals, and coach guidance.'}</small>
            </span>
            <span class="le-client-module__arrow">→</span>
          </button>
          <button type="button" class="le-client-module" data-care-destination="supplements">
            <span class="le-client-module__icon">◌</span>
            <span class="le-client-module__body">
              <span class="le-client-module__top"><strong>Supplements</strong>${planStatus(supplements)}</span>
              <small>${supplements ? `${supplementCount} items in your current plan` : 'Your coach-approved supplement plan.'}</small>
            </span>
            <span class="le-client-module__arrow">→</span>
          </button>
          <button type="button" class="le-client-module le-client-module--protocol" data-care-destination="protocol">
            <span class="le-client-module__icon">◇</span>
            <span class="le-client-module__body">
              <span class="le-client-module__top"><strong>Peptide Protocol</strong>${planStatus(protocol)}</span>
              <small>${protocol ? `${protocolCount} clinician-confirmed protocol item${protocolCount === 1 ? '' : 's'}` : 'Visible only after licensed-clinician confirmation.'}</small>
            </span>
            <span class="le-client-module__arrow">→</span>
          </button>
        </div>
      </section>`;
  }

  function assistantMarkup() {
    return `
      <section class="le-assistant" data-lion-assistant>
        <div class="le-assistant__head">
          <div class="le-assistant__identity"><span class="le-assistant__mark">LE</span><div><strong>Lion Assistant</strong><small>Instant plan support · your coach stays in the loop</small></div></div>
          <span class="le-assistant__online"><i></i> Online</span>
        </div>
        <div class="le-assistant__body">
          <div class="le-assistant__bubble le-assistant__bubble--assistant">Ask me about today’s workout, your macros, supplement plan, check-ins, or where to find something in the app. Medical or protocol changes go directly to your coach/clinician.</div>
          <div class="le-assistant__quick">
            <button type="button" data-assistant-question="What is my next workout?">Next workout</button>
            <button type="button" data-assistant-question="What are my nutrition targets?">My macros</button>
            <button type="button" data-assistant-question="What supplements are on my plan?">Supplements</button>
            <button type="button" data-assistant-question="What does my peptide protocol say?">Protocol</button>
          </div>
          <div class="le-assistant__thread" data-assistant-thread></div>
          <form class="le-assistant__composer" data-assistant-form>
            <input name="question" maxlength="500" autocomplete="off" placeholder="Ask Lion Assistant…" required>
            <button type="submit" aria-label="Send question">↑</button>
          </form>
        </div>
      </section>`;
  }

  function answerQuestion(raw) {
    const question = String(raw || '').trim();
    const q = question.toLowerCase();
    if (!dashboard) return 'I’m still loading your coaching plan. Try that again in a second.';

    if (/dose|dosing|inject|injection|side effect|reaction|pain|medical|medication|change.*protocol|increase|decrease/.test(q)) {
      return 'That needs your human coach and, when it involves medical instructions or your peptide protocol, the licensed clinician who confirmed it. I won’t invent or change medical instructions. Send that question in the coach chat so it can be handled correctly.';
    }

    if (/next workout|workout today|training today|train today|my workout/.test(q)) {
      const plan = dashboard.workoutPlan;
      if (!plan?.days?.length) return 'Your coach has not published a workout plan yet. As soon as it is live, it will appear under Training.';
      const day = plan.days[0];
      const names = (day.exercises || []).slice(0, 4).map(ex => ex.name).filter(Boolean);
      return `Your current plan is “${plan.title}.” Your next listed session is “${day.title}” with ${day.exercises?.length || 0} exercises${names.length ? `, including ${names.join(', ')}` : ''}. Open Training for the videos, sets, reps, and logging.`;
    }

    if (/macro|calorie|protein|carb|fat|nutrition|diet|meal/.test(q)) {
      const plan = dashboard.nutrition;
      if (!plan) return 'Your nutrition plan is still pending. Your coach can publish calories, macros, meals, and guidance in My Plan.';
      return `Your current nutrition plan is “${plan.title}.” Targets shown in the app: ${plan.calorieTarget ?? '—'} calories, ${plan.proteinGrams ?? '—'}g protein, ${plan.carbohydrateGrams ?? '—'}g carbs, and ${plan.fatGrams ?? '—'}g fat. Open My Plan → Nutrition for your full meal framework and coach guidance.`;
    }

    if (/supplement|vitamin|fish oil|creatine|omega/.test(q)) {
      const plan = dashboard.supplements;
      if (!plan?.items?.length) return 'There is no published supplement plan yet. When your coach publishes one, it will appear under My Plan → Supplements.';
      const items = plan.items.slice(0, 6).map(item => [item.name, item.amount, item.timing].filter(Boolean).join(' · '));
      return `Your published supplement plan is “${plan.title}.” It currently lists: ${items.join('; ')}${plan.items.length > 6 ? '; and more in the app' : ''}. Open My Plan → Supplements for the complete notes. Confirm medication or condition-related questions with a licensed clinician or pharmacist.`;
    }

    if (/peptide|protocol/.test(q)) {
      const plan = dashboard.protocol;
      if (!plan) return 'There is no clinician-confirmed peptide protocol published in your app right now. The app will only display one after your coach confirms it came from a licensed clinician.';
      const items = (plan.items || []).map(item => item.name).filter(Boolean);
      return `Your app has a clinician-confirmed protocol titled “${plan.title}”${plan.clinicianName ? ` from ${plan.clinicianName}` : ''}. It includes ${items.length ? items.join(', ') : 'the items shown in your protocol tab'}. Open My Plan → Peptide Protocol to read the exact confirmed instructions. I will not change, interpret, or generate dosing.`;
    }

    if (/check.?in|progress|weight|sleep|energy|adherence/.test(q)) {
      const latest = dashboard.checkins?.[0];
      if (!latest) return 'You have not submitted a check-in yet. Open Progress to log weight, sleep, energy, adherence, soreness, and notes for your coach.';
      return `Your latest check-in shows ${latest.weightLbs ? `${latest.weightLbs} lb, ` : ''}${latest.sleepHours ? `${latest.sleepHours} hours sleep, ` : ''}${latest.energy ? `energy ${latest.energy}/10, ` : ''}${latest.adherence ? `adherence ${latest.adherence}/10` : 'your current progress data'}. Open Progress for the full history and your next check-in.`;
    }

    if (/message|coach|contact|talk/.test(q)) {
      return 'You’re already in Messages. Use the main coach composer below to send a direct message to your human coach. I can handle quick plan questions, but anything personal, medical, or requiring a plan adjustment should go to your coach.';
    }

    return 'I can help with your current workout, nutrition targets, supplement plan, check-ins, app navigation, and what is already published in your protocol. For plan changes or anything medical, I’ll send you to your human coach instead of guessing.';
  }

  function appendAssistantExchange(question) {
    const thread = document.querySelector('[data-assistant-thread]');
    if (!thread) return;
    const answer = answerQuestion(question);
    thread.insertAdjacentHTML('beforeend', `
      <div class="le-assistant__bubble le-assistant__bubble--client">${esc(question)}</div>
      <div class="le-assistant__bubble le-assistant__bubble--assistant">${esc(answer)}</div>`);
    thread.scrollTop = thread.scrollHeight;
  }

  function injectTodayHub() {
    const main = document.querySelector('#main-content');
    if (!main || main.querySelector('[data-client-care-hub]')) return;
    const pageHead = main.querySelector('.page-head');
    if (!pageHead) return;
    pageHead.insertAdjacentHTML('afterend', careHub());
  }

  function injectAssistant() {
    const main = document.querySelector('#main-content');
    if (!main || main.querySelector('[data-lion-assistant]')) return;
    const pageHead = main.querySelector('.page-head');
    if (!pageHead) return;
    pageHead.insertAdjacentHTML('afterend', assistantMarkup());
  }

  async function refresh() {
    try {
      const session = await api('/session');
      actor = session.actor;
      if (!actor || actor.actorType !== 'client') return;
      const response = await api('/dashboard');
      dashboard = response.dashboard;
      const view = currentView();
      lastView = view;
      if (view === 'today') injectTodayHub();
      if (view === 'messages') injectAssistant();
    } catch (_) {
      // Existing app owns auth/error presentation.
    }
  }

  document.addEventListener('click', event => {
    const destination = event.target.closest('[data-care-destination]');
    if (destination) {
      const target = destination.dataset.careDestination;
      if (target === 'workouts') {
        location.hash = '#workouts';
        return;
      }
      location.hash = '#plan';
      setTimeout(() => {
        const tab = [...document.querySelectorAll('[data-action="care-tab"]')].find(node => node.dataset.tab === target);
        tab?.click();
      }, 80);
      return;
    }

    const quick = event.target.closest('[data-assistant-question]');
    if (quick) appendAssistantExchange(quick.dataset.assistantQuestion);
  });

  document.addEventListener('submit', event => {
    const form = event.target.closest('[data-assistant-form]');
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();
    const input = form.elements.question;
    const question = input.value.trim();
    if (!question) return;
    appendAssistantExchange(question);
    input.value = '';
  }, true);

  const observer = new MutationObserver(() => {
    if (!actor || actor.actorType !== 'client') return;
    const view = currentView();
    if (view === 'today') injectTodayHub();
    if (view === 'messages') injectAssistant();
  });

  window.addEventListener('load', () => {
    const root = document.querySelector('#app-shell');
    if (root) observer.observe(root, { childList: true, subtree: true });
    setTimeout(refresh, 900);
  });
  window.addEventListener('hashchange', () => setTimeout(refresh, 120));
})();