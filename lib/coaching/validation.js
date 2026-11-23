'use strict';

function badRequest(message, details) {
  const error = new Error(message);
  error.statusCode = 400;
  if (details) error.details = details;
  return error;
}

function cleanText(value, { field = 'value', max = 500, required = false } = {}) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (required && !text) throw badRequest(`${field} is required.`);
  if (text.length > max) throw badRequest(`${field} must be ${max} characters or fewer.`);
  return text;
}

function cleanEmail(value) {
  const email = cleanText(value, { field: 'Email', max: 254, required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid email address.');
  return email;
}

function cleanInteger(value, { field, min, max, nullable = true } = {}) {
  if (value === '' || value == null) {
    if (nullable) return null;
    throw badRequest(`${field} is required.`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${field} must be a whole number between ${min} and ${max}.`);
  }
  return number;
}

function cleanNumber(value, { field, min, max, nullable = true } = {}) {
  if (value === '' || value == null) {
    if (nullable) return null;
    throw badRequest(`${field} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw badRequest(`${field} must be between ${min} and ${max}.`);
  }
  return number;
}

function cleanArray(value, { field = 'Items', max = 100 } = {}) {
  if (!Array.isArray(value)) throw badRequest(`${field} must be a list.`);
  if (value.length > max) throw badRequest(`${field} can contain at most ${max} items.`);
  return value;
}

function cleanSlug(value) {
  const slug = cleanText(value, { field: 'Slug', max: 100, required: true })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw badRequest('Slug must contain letters or numbers.');
  return slug;
}

function videoDetails(value) {
  const raw = cleanText(value, { field: 'Exercise video URL', max: 1000, required: true });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Exercise video URL must be a complete HTTPS URL.');
  }
  if (url.protocol !== 'https:') throw badRequest('Exercise video URL must use HTTPS.');

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    let id = url.searchParams.get('v');
    if (!id && url.pathname.startsWith('/embed/')) id = url.pathname.split('/')[2];
    if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) throw badRequest('YouTube video URL is not recognized.');
    return { url: raw, kind: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    if (!id || !/^[a-zA-Z0-9_-]{6,20}$/.test(id)) throw badRequest('YouTube video URL is not recognized.');
    return { url: raw, kind: 'youtube', embedUrl: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const id = url.pathname.split('/').filter(Boolean).find(part => /^\d+$/.test(part));
    if (!id) throw badRequest('Vimeo video URL is not recognized.');
    return { url: raw, kind: 'vimeo', embedUrl: `https://player.vimeo.com/video/${id}` };
  }
  if (/\.(mp4|webm|mov)$/i.test(url.pathname)) {
    return { url: raw, kind: 'video', embedUrl: raw };
  }
  return { url: raw, kind: 'link', embedUrl: raw };
}

function sanitizeSet(set, index) {
  const source = set && typeof set === 'object' ? set : {};
  return {
    label: cleanText(source.label || `Set ${index + 1}`, { field: 'Set label', max: 40 }),
    reps: cleanText(source.reps, { field: 'Reps', max: 30, required: true }),
    target: cleanText(source.target, { field: 'Target', max: 80 }),
    restSeconds: cleanInteger(source.restSeconds ?? 90, { field: 'Rest seconds', min: 0, max: 900, nullable: false }),
    rpe: cleanNumber(source.rpe, { field: 'RPE', min: 1, max: 10 })
  };
}

function sanitizeWorkoutPlan(value) {
  const source = value && typeof value === 'object' ? value : {};
  const days = cleanArray(source.days || [], { field: 'Workout days', max: 14 });
  if (!days.length) throw badRequest('Add at least one workout day.');
  return {
    title: cleanText(source.title, { field: 'Plan title', max: 120, required: true }),
    summary: cleanText(source.summary, { field: 'Plan summary', max: 2000 }),
    startDate: source.startDate || null,
    endDate: source.endDate || null,
    days: days.map((day, dayIndex) => {
      const exercises = cleanArray(day?.exercises || [], { field: `Day ${dayIndex + 1} exercises`, max: 30 });
      if (!exercises.length) throw badRequest(`Day ${dayIndex + 1} needs at least one exercise.`);
      return {
        dayIndex: dayIndex + 1,
        title: cleanText(day?.title || `Day ${dayIndex + 1}`, { field: 'Workout day title', max: 100, required: true }),
        instructions: cleanText(day?.instructions, { field: 'Workout instructions', max: 2000 }),
        exercises: exercises.map((exercise, exerciseIndex) => {
          const video = videoDetails(exercise?.videoUrl);
          const sets = cleanArray(exercise?.sets || [], { field: 'Exercise sets', max: 20 });
          if (!sets.length) throw badRequest(`${exercise?.name || 'Exercise'} needs at least one set.`);
          return {
            exerciseId: exercise?.exerciseId || null,
            name: cleanText(exercise?.name, { field: 'Exercise name', max: 120, required: true }),
            instructions: cleanText(exercise?.instructions, { field: 'Exercise instructions', max: 2000 }),
            videoUrl: video.url,
            videoKind: video.kind,
            embedUrl: video.embedUrl,
            sets: sets.map(sanitizeSet),
            sortOrder: exerciseIndex
          };
        })
      };
    })
  };
}

module.exports = {
  badRequest,
  cleanArray,
  cleanEmail,
  cleanInteger,
  cleanNumber,
  cleanSlug,
  cleanText,
  sanitizeWorkoutPlan,
  videoDetails
};
