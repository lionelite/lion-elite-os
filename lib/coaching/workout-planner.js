'use strict';

const { cleanInteger, cleanText, sanitizeWorkoutPlan } = require('./validation');

function normalizeProfile(value = {}) {
  const equipment = Array.isArray(value.equipment)
    ? value.equipment.map(item => cleanText(item, { field: 'Equipment', max: 80 })).filter(Boolean).slice(0, 30)
    : [];
  return {
    goal: cleanText(value.goal || 'general strength and fitness', { field: 'Goal', max: 300, required: true }),
    experienceLevel: cleanText(value.experienceLevel || 'intermediate', { field: 'Experience level', max: 40 }),
    daysPerWeek: cleanInteger(value.daysPerWeek ?? 3, { field: 'Training days per week', min: 1, max: 7, nullable: false }),
    sessionMinutes: cleanInteger(value.sessionMinutes ?? 60, { field: 'Session length', min: 20, max: 180, nullable: false }),
    equipment,
    limitations: cleanText(value.limitations, { field: 'Limitations', max: 1200 })
  };
}

function eligibleExercises(exercises, profile) {
  const available = (exercises || []).filter(exercise => exercise.active !== false && exercise.videoUrl);
  if (!profile.equipment.length) return available;
  const equipment = new Set(profile.equipment.map(value => value.toLowerCase()));
  return available.filter(exercise => {
    const required = String(exercise.equipment || '').toLowerCase();
    return !required || required === 'bodyweight' || required === 'other' || equipment.has(required);
  });
}

function targetReps(goal) {
  const normalized = goal.toLowerCase();
  if (/strength|power/.test(normalized)) return '5-8';
  if (/endurance|conditioning|fat loss/.test(normalized)) return '12-15';
  return '8-12';
}

function buildFallbackDraft(profileInput, exercises) {
  const profile = normalizeProfile(profileInput);
  const library = eligibleExercises(exercises, profile);
  if (library.length < 3) {
    const error = new Error('Add at least three active exercise videos that match the client equipment before generating a workout.');
    error.statusCode = 422;
    throw error;
  }

  const exercisesPerDay = Math.max(3, Math.min(6, Math.floor(profile.sessionMinutes / 12)));
  const reps = targetReps(profile.goal);
  const days = [];
  for (let dayIndex = 0; dayIndex < profile.daysPerWeek; dayIndex += 1) {
    const dayExercises = [];
    for (let offset = 0; offset < Math.min(exercisesPerDay, library.length); offset += 1) {
      const exercise = library[(dayIndex * exercisesPerDay + offset) % library.length];
      dayExercises.push({
        exerciseId: exercise.exerciseId,
        name: exercise.name,
        instructions: exercise.instructions || '',
        videoUrl: exercise.videoUrl,
        sets: Array.from({ length: 3 }, (_, setIndex) => ({
          label: `Set ${setIndex + 1}`,
          reps,
          target: 'Leave 2-3 good reps in reserve; technique stays clean.',
          restSeconds: /strength|power/i.test(profile.goal) ? 150 : 90,
          rpe: 7
        }))
      });
    }
    days.push({
      title: profile.daysPerWeek <= 3 ? `Full Body ${dayIndex + 1}` : `Training Day ${dayIndex + 1}`,
      instructions: `Complete a gradual warm-up first. Stop and contact your coach if pain is sharp, sudden, or worsening.${profile.limitations ? ` Coach note: ${profile.limitations}` : ''}`,
      exercises: dayExercises
    });
  }

  return sanitizeWorkoutPlan({
    title: `${profile.daysPerWeek}-Day ${profile.goal} Plan`,
    summary: `Coach-review draft for a ${profile.experienceLevel} client, built only from the approved Lion Elite exercise video library.`,
    days
  });
}

function stripCodeFence(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

async function buildAiDraft(profileInput, exercises, fetchImpl = fetch) {
  const profile = normalizeProfile(profileInput);
  const library = eligibleExercises(exercises, profile);
  if (library.length < 3) return buildFallbackDraft(profile, library);

  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You help a human fitness coach draft a workout for review. Return JSON only.',
            'Use ONLY exerciseId values from the supplied approved library; every item already has a coach-approved video.',
            'Do not diagnose, prescribe rehabilitation, override medical restrictions, recommend drugs/supplements/peptides, or invent exercises.',
            'Respect stated limitations conservatively. If limitations suggest clinical clearance is needed, note that in day instructions.',
            'Use RPE 6-8, clear rep ranges, realistic rest, and no mandatory load numbers.',
            'Schema: {title, summary, days:[{title,instructions,exercises:[{exerciseId,sets:[{label,reps,target,restSeconds,rpe}]}]}]}.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            profile,
            approvedExerciseLibrary: library.map(exercise => ({
              exerciseId: exercise.exerciseId,
              name: exercise.name,
              muscleGroup: exercise.muscleGroup,
              equipment: exercise.equipment,
              instructions: exercise.instructions
            }))
          })
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`Workout assistant request failed (${response.status}).`);
  const payload = await response.json();
  const generated = JSON.parse(stripCodeFence(payload.choices?.[0]?.message?.content));
  const byId = new Map(library.map(exercise => [exercise.exerciseId, exercise]));
  generated.days = Array.isArray(generated.days) ? generated.days.slice(0, profile.daysPerWeek) : [];
  if (generated.days.length !== profile.daysPerWeek) throw new Error('Workout assistant returned the wrong number of training days.');
  generated.days = generated.days.map(day => ({
    ...day,
    exercises: (day.exercises || []).map(item => {
      const exercise = byId.get(item.exerciseId);
      if (!exercise) throw new Error('Workout assistant selected an exercise outside the approved video library.');
      return {
        ...item,
        name: exercise.name,
        instructions: exercise.instructions || '',
        videoUrl: exercise.videoUrl
      };
    })
  }));
  return sanitizeWorkoutPlan(generated);
}

async function generateWorkoutDraft(profile, exercises, options = {}) {
  if (!process.env.OPENAI_API_KEY || options.forceFallback) {
    return { mode: 'rule-based', plan: buildFallbackDraft(profile, exercises) };
  }
  try {
    return { mode: 'ai-assisted', plan: await buildAiDraft(profile, exercises, options.fetchImpl || fetch) };
  } catch (error) {
    return { mode: 'rule-based-after-ai-error', warning: error.message, plan: buildFallbackDraft(profile, exercises) };
  }
}

module.exports = {
  buildAiDraft,
  buildFallbackDraft,
  eligibleExercises,
  generateWorkoutDraft,
  normalizeProfile
};
