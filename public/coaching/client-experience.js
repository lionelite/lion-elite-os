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

  function eliteDashboard() {
    if (!dashboard) return '';
    const workout = dashboard.workoutPlan;
    const nutrition = dashboard.nutrition;
    const supplements = dashboard.supplements;
    const protocol = dashboard.protocol;
    const latest = dashboard.checkins?.[0];
    const nextWorkout = workout?.days?.[0];
    const targets = [
      { label: 'Training', value: nextWorkout ? nextWorkout.title : 'Plan pending', dest: 'workouts' },
      { label: 'Nutrition', value: nutrition?.calorieTarget ? `${nutrition.calorieTarget} cal · ${nutrition.proteinGrams || '—'}g protein` : 'Targets pending', dest: 'nutrition' },
      { label: 'Check-In', value: latest ? 'Latest submitted' : 'Complete first check-in', dest: 'progress' }
    ];

    return `<section class="le-elite-dashboard" data-elite-dashboard>
      <div class="le-elite-hero">
        <div><p class="eyebrow">ELITE DASHBOARD</p><h2>Your standard. Your next move.</h2><p class="muted">Everything your coach needs you focused on today, in one private performance system.</p></div>
        <span class="le-elite-badge">VIP COACHING</span>
      </div>
      <div class="le-daily-targets">
        <div class="le-section-title"><div><p class="eyebrow">DAILY TARGETS</p><h3>What needs your attention</h3></div></div>
        <div class="le-target-grid">${targets.map(target => `<button type="button" class="le-target-card" data-elite-destination="${target.dest}"><small>${target.label}</small><strong>${esc(target.value)}</strong><span>Open →</span></button>`).join('')}</div>
      </div>
      <div class="le-client-hub__head"><div><p class="eyebrow">YOUR COACHING SYSTEM</p><h3>Built around your progress</h3><p class="muted">Training, nutrition, supplements, clinician-confirmed protocol information, progress, and coach access stay connected.</p></div></div>
      <div class="le-client-hub__grid">
        <button type="button" class="le-client-module le-client-module--training" data-elite-destination="workouts"><span class="le-client-module__icon">◫</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Training</strong>${planStatus(workout)}</span><small>${nextWorkout ? `${esc(nextWorkout.title)} · ${workout.days.length} sessions` : 'Your coach is building your program.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="nutrition"><span class="le-client-module__icon">◎</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Nutrition</strong>${planStatus(nutrition)}</span><small>${nutrition?.calorieTarget ? `${nutrition.calorieTarget} calories · ${nutrition.proteinGrams || '—'}g protein` : 'Macros, meals, and coach direction.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="supplements"><span class="le-client-module__icon">◌</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Supplements</strong>${planStatus(supplements)}</span><small>${supplements ? `${supplements.items?.length || 0} items in your current plan` : 'Your coach-published supplement plan.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module le-client-module--protocol" data-elite-destination="protocol"><span class="le-client-module__icon">◇</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Protocol</strong>${planStatus(protocol)}</span><small>${protocol ? `${protocol.items?.length || 0} clinician-confirmed item${protocol.items?.length === 1 ? '' : 's'}` : 'Visible only after licensed-clinician confirmation.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="progress"><span class="le-client-module__icon">↗</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Elite Progress</strong><span class="le-plan-status le-plan-status--live">Track</span></span><small>${latest?.weightLbs ? `Latest: ${latest.weightLbs} lb` : 'Check-ins, performance, recovery, and trends.'}</small></span><span class="le-client-module__arrow">→</span></button>
        <button type="button" class="le-client-module" data-elite-destination="messages"><span class="le-client-module__icon">✦</span><span class="le-client-module__body"><span class="le-client-module__top"><strong>Coach Access</strong><span class="le-plan-status le-plan-status--live">Direct</span></span><small>Message your coach or ask Lion Assistant about your published plan.</small></span><span class="le-client-module__arrow">→</span></button>
      </div>
    </section>`;
  }

  function assistantMarkup() {
    return `<section class="le-assistant" data-lion-assistant><div class="le-assistant__head"><div class="le-assistant__identity"><span class="le-assistant__mark">LE</span><div><strong>Lion Assistant</strong><small>Elite plan support · your coach stays in control</small></div></div><span class="le-assistant__online"><i></i> Online</span></div><div class="le-assistant__body"><div class="le-assistant__bubble le-assistant__bubble--assistant">I can help you understand today’s training, nutrition targets, supplement plan, check-ins, and where to find information your coach has published. Medical questions or protocol changes go directly to your coach/clinician.</div><div class="le-assistant__quick"><button type="button" data-assistant-question="What is my next workout?">Next workout</button><button type="button" data-assistant-question="What are my nutrition targets?">My macros</button><button type="button" data-assistant-question="What supplements are on my plan?">Supplements</button><button type="button" data-assistant-question="What does my protocol say?">Protocol</button></div><div class="le-assistant__thread" data-assistant-thread></div><form class="le-assistant__composer" data-assistant-form><input name="question" maxlength="500" autocomplete="off" placeholder="Ask Lion Assistant…" required><button type="submit" aria-label="Send question">↑</button></form></div></section>`;
  }

  function answerQuestion(raw) {
    const q = String(raw || '').trim().toLowerCase();
    if (!dashboard) return 'I’m still loading your coaching plan. Try that again in a second.';
    if (/dose|dosing|inject|injection|side effect|reaction|pain|medical|medication|change.*protocol|increase|decrease/.test(q)) return 'That needs your human coach and, when medical instructions or protocol are involved, the licensed clinician who confirmed it. I won’t create or change medical instructions. Send it in coach chat so it can be handled correctly.';
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