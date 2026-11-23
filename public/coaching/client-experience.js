(() => {
  'use strict';

  const API = '/api/coaching';
  let actor = null;
  let dashboard = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  async function api(path) {
    const response = await fetch(`${API}${path}`, { credentials: 'same-origin' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to load coaching data.');
    return payload;
  }

  function currentView() { return location.hash.replace(/^#/, '') || 'today'; }
  function planStatus(item) { return item ? '<span class="le-plan-status le-plan-status--live">Live</span>' : '<span class="le-plan-status le-plan-status--pending">Pending</span>'; }

  function weekRail() {
    const now = new Date();
    const days = [];
    for (let offset = -3; offset <= 3; offset += 1) {
      const d = new Date(now);
      d.setDate(now.getDate() + offset);
      days.push(`<div class="le-week-day ${offset === 0 ? 'is-today' : ''}"><small>${d.toLocaleDateString(undefined,{weekday:'short'}).slice(0,3)}</small><strong>${d.getDate()}</strong>${offset === 0 ? '<i></i>' : ''}</div>`);
    }
    return `<div class="le-week-rail">${days.join('')}</div>`;
  }

  function completionRing(done,total,label) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="le-completion-card"><div class="le-ring" style="--p:${pct}"><span>${pct}%</span></div><div><small>${label}</small><strong>${done}/${total} complete</strong><p>${pct === 100 ? 'Day handled.' : 'Keep the standard moving.'}</p></div></div>`;
  }

  function eliteDashboard() {
    if (!dashboard) return '';
    const workout = dashboard.workoutPlan;
    const nutrition = dashboard.nutrition;
    const supplements = dashboard.supplements;
    const protocol = dashboard.protocol;
    const latest = dashboard.checkins?.[0];
    const nextWorkout = workout?.days?.[0];
    const assigned = [workout, nutrition, supplements].filter(Boolean).length + 1;
    const completed = [nextWorkout, nutrition, latest].filter(Boolean).length;

    return `<section class="le-elite-dashboard" data-elite-dashboard>
      <div class="le-mobile-topline"><div><p class="eyebrow">LION ELITE COACHING</p><h2>Today</h2></div><span class="le-elite-badge">VIP</span></div>
      ${weekRail()}
      <div class="le-elite-hero">
        <div><p class="eyebrow">ELITE DASHBOARD</p><h3>Your standard. Your next move.</h3><p class="muted">Your training, nutrition, accountability, progress and direct coach access in one place.</p></div>
        <button class="le-primary-action" type="button" data-elite-destination="workouts">Start training →</button>
      </div>

      <div class="le-today-layout">
        <div class="le-today-feed">
          <div class="le-section-title"><div><p class="eyebrow">TODAY</p><h3>Coach-assigned priorities</h3></div><span class="le-count-chip">${completed}/${assigned}</span></div>
          <button type="button" class="le-agenda-card le-agenda-card--training" data-elite-destination="workouts"><div class="le-agenda-icon">01</div><div class="le-agenda-copy"><small>TRAINING</small><strong>${nextWorkout ? esc(nextWorkout.title) : 'Training plan pending'}</strong><span>${nextWorkout ? `${nextWorkout.exercises?.length || 0} exercises · coach programmed` : 'Your coach is building your next session.'}</span></div><b>→</b></button>
          <button type="button" class="le-agenda-card" data-elite-destination="nutrition"><div class="le-agenda-icon">02</div><div class="le-agenda-copy"><small>NUTRITION</small><strong>${nutrition?.calorieTarget ? `${nutrition.calorieTarget} calories` : 'Nutrition targets pending'}</strong><span>${nutrition ? `${nutrition.proteinGrams || '—'}g protein · ${nutrition.carbohydrateGrams || '—'}g carbs · ${nutrition.fatGrams || '—'}g fats` : 'Macros and coach direction will appear here.'}</span></div><b>→</b></button>
          <button type="button" class="le-agenda-card" data-elite-destination="progress"><div class="le-agenda-icon">03</div><div class="le-agenda-copy"><small>CHECK-IN</small><strong>${latest ? 'Latest check-in received' : 'Check-in due'}</strong><span>${latest?.weightLbs ? `${latest.weightLbs} lb logged · review your progress` : 'Log progress, recovery, adherence and feedback.'}</span></div><b>→</b></button>
        </div>
        <aside class="le-today-side">
          ${completionRing(completed,assigned,'Daily execution')}
          <button type="button" class="le-coach-card" data-elite-destination="messages"><div><small>DIRECT COACH ACCESS</small><strong>Need an adjustment?</strong><span>Message your coach inside the app.</span></div><b>Open chat →</b></button>
        </aside>
      </div>

      <div class="le-client-hub__head"><div><p class="eyebrow">COACHING</p><h3>Your complete system</h3><p class="muted">Everything stays connected so your plan can evolve from real progress instead of guesswork.</p></div></div>
      <div class="le-client-hub__grid">
        <button type="button" class="le-client-module le-client-module--training" data-elite-destination="workouts"><span class="le-client-module__icon">T</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Training</strong>${planStatus(workout)}</span><small>${nextWorkout ? `${esc(nextWorkout.title)} · ${workout.days.length} sessions` : 'Coach-programmed workouts, videos, sets and reps.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="nutrition"><span class="le-client-module__icon">N</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Nutrition</strong>${planStatus(nutrition)}</span><small>${nutrition?.calorieTarget ? `${nutrition.calorieTarget} calories · ${nutrition.proteinGrams || '—'}g protein` : 'Macros, food guidance and accountability.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="supplements"><span class="le-client-module__icon">S</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Supplements</strong>${planStatus(supplements)}</span><small>${supplements ? `${supplements.items?.length || 0} items in your current plan` : 'Your coach-published supplement plan.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module le-client-module--protocol" data-elite-destination="protocol"><span class="le-client-module__icon">P</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Peptide Protocol</strong>${planStatus(protocol)}</span><small>${protocol ? `${protocol.items?.length || 0} clinician-confirmed item${protocol.items?.length === 1 ? '' : 's'}` : 'Clinician-confirmed information only.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="progress"><span class="le-client-module__icon">↗</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Elite Progress</strong><span class="le-plan-status le-plan-status--live">Track</span></span><small>${latest?.weightLbs ? `Latest: ${latest.weightLbs} lb` : 'Check-ins, photos, performance and trends.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="messages"><span class="le-client-module__icon">✦</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Coach Access</strong><span class="le-plan-status le-plan-status--live">Direct</span></span><small>1:1 messaging plus Lion Assistant plan support.</small></span><span class="le-client-module__arrow">→</span></button>
      </div>
    </section>`;
  }

  function assistantMarkup() {
    return `<section class="le-assistant" data-lion-assistant><div class="le-assistant__head"><div class="le-assistant__identity"><span class="le-assistant__mark">LE</span><div><strong>Lion Assistant</strong><small>Elite plan support · your coach stays in control</small></div></div><span class="le-assistant__online"><i></i> Online</span></div><div class="le-assistant__body"><div class="le-assistant__bubble le-assistant__bubble--assistant">I can help you understand today’s training, nutrition targets, supplement plan, check-ins, and where to find information your coach has published. Medical questions or protocol changes go directly to your coach or clinician.</div><div class="le-assistant__quick"><button type="button" data-assistant-question="What is my next workout?">Next workout</button><button type="button" data-assistant-question="What are my nutrition targets?">My macros</button><button type="button" data-assistant-question="What supplements are on my plan?">Supplements</button><button type="button" data-assistant-question="What does my protocol say?">Protocol</button></div><div class="le-assistant__thread" data-assistant-thread></div><form class="le-assistant__composer" data-assistant-form><input name="question" maxlength="500" autocomplete="off" placeholder="Ask Lion Assistant…" required><button type="submit" aria-label="Send question">↑</button></form></div></section>`;
  }

  function answerQuestion(raw) {
    const q = String(raw || '').trim().toLowerCase();
    if (!dashboard) return 'I’m still loading your coaching plan. Try that again in a second.';
    if (/dose|dosing|inject|injection|side effect|reaction|pain|medical|medication|change.*protocol|increase|decrease/.test(q)) return 'That needs your human coach and, when medical instructions or protocol are involved, the licensed clinician who confirmed it. I won’t invent or change medical instructions. Send it in coach chat so it can be handled correctly.';
    if (/workout|training/.test(q)) { const p=dashboard.workoutPlan,d=p?.days?.[0]; return d ? `Your next listed session is “${d.title}” with ${d.exercises?.length || 0} exercises. Open Training for sets, reps, videos, and logging.` : 'Your coach has not published a workout plan yet.'; }
    if (/macro|calorie|protein|carb|fat|nutrition|diet|meal/.test(q)) { const p=dashboard.nutrition; return p ? `Your current targets are ${p.calorieTarget ?? '—'} calories, ${p.proteinGrams ?? '—'}g protein, ${p.carbohydrateGrams ?? '—'}g carbs, and ${p.fatGrams ?? '—'}g fat. Open Nutrition for your full coach guidance.` : 'Your nutrition plan is still pending.'; }
    if (/supplement|vitamin|creatine|omega/.test(q)) { const p=dashboard.supplements; return p?.items?.length ? `Your published supplement plan currently contains ${p.items.length} items. Open Supplements for the exact coach-published plan.` : 'There is no published supplement plan yet.'; }
    if (/peptide|protocol/.test(q)) { const p=dashboard.protocol; return p ? `Your app has a clinician-confirmed protocol titled “${p.title}”. Open Protocol to read the exact confirmed instructions. I will not change, interpret, or generate dosing.` : 'There is no clinician-confirmed protocol published right now.'; }
    if (/check.?in|progress|weight|sleep|energy|adherence/.test(q)) { const p=dashboard.checkins?.[0]; return p ? `Your latest check-in${p.weightLbs ? ` shows ${p.weightLbs} lb` : ' is on file'}. Open Elite Progress for your full history.` : 'You have not submitted a check-in yet. Open Elite Progress to complete your first one.'; }
    return 'I can help with your published Training, Nutrition, Supplements, Elite Progress, and app navigation. For plan changes or anything medical, I’ll route you to your human coach instead of guessing.';
  }

  function appendAssistantExchange(question) { const thread=document.querySelector('[data-assistant-thread]'); if(!thread)return; thread.insertAdjacentHTML('beforeend',`<div class="le-assistant__bubble le-assistant__bubble--client">${esc(question)}</div><div class="le-assistant__bubble le-assistant__bubble--assistant">${esc(answerQuestion(question))}</div>`); thread.scrollTop=thread.scrollHeight; }
  function injectTodayHub() { const main=document.querySelector('#main-content'); if(!main||main.querySelector('[data-elite-dashboard]'))return; const head=main.querySelector('.page-head'); if(head) head.insertAdjacentHTML('afterend',eliteDashboard()); }
  function injectAssistant() { const main=document.querySelector('#main-content'); if(!main||main.querySelector('[data-lion-assistant]'))return; const head=main.querySelector('.page-head'); if(head) head.insertAdjacentHTML('afterend',assistantMarkup()); }
  function navigate(target) { if(['workouts','progress','messages'].includes(target)){location.hash=`#${target}`;return;} location.hash='#plan'; setTimeout(()=>{[...document.querySelectorAll('[data-action="care-tab"]')].find(n=>n.dataset.tab===target)?.click();},80); }

  async function refresh(){ try { const session=await api('/session'); actor=session.actor; if(!actor||actor.actorType!=='client')return; dashboard=(await api('/dashboard')).dashboard; if(currentView()==='today')injectTodayHub(); if(currentView()==='messages')injectAssistant(); } catch(_){} }
  document.addEventListener('click',e=>{ const dest=e.target.closest('[data-elite-destination]'); if(dest){navigate(dest.dataset.eliteDestination);return;} const quick=e.target.closest('[data-assistant-question]'); if(quick)appendAssistantExchange(quick.dataset.assistantQuestion); });
  document.addEventListener('submit',e=>{ const form=e.target.closest('[data-assistant-form]'); if(!form)return; e.preventDefault(); e.stopPropagation(); const input=form.elements.question,q=input.value.trim(); if(q){appendAssistantExchange(q);input.value='';}},true);
  const observer=new MutationObserver(()=>{ if(!actor||actor.actorType!=='client')return; if(currentView()==='today')injectTodayHub(); if(currentView()==='messages')injectAssistant(); });
  window.addEventListener('load',()=>{const root=document.querySelector('#app-shell');if(root)observer.observe(root,{childList:true,subtree:true});setTimeout(refresh,900);});
  window.addEventListener('hashchange',()=>setTimeout(refresh,120));
})();