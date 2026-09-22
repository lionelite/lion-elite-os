'use strict';

function splitCsv(text) {
  return String(text || '').split(',').map(x => x.trim()).filter(Boolean);
}

function inferIndustries(prompt) {
  const patterns = [
    /(?:find|target|reach|contact|book calls with|book meetings with)\s+(.+?)\s+(?:in|across|with|that|who|and)/i,
    /(?:for|to)\s+(.+?)\s+(?:in|with|who|that)/i
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match && match[1]) return splitCsv(match[1].replace(/owners?|businesses?|companies?|people/gi, '').trim());
  }
  return [];
}

function inferGeography(prompt) {
  const match = prompt.match(/\b(?:in|across|around|near)\s+([A-Z][A-Za-z .-]+?)(?:\s+with|\s+who|\s+that|\s+and|\.|,|$)/);
  return match ? match[1].trim() : '';
}

function inferEmployeeRange(prompt) {
  const match = prompt.match(/(\d+)\s*(?:-|to)\s*(\d+)\s+employees?/i);
  if (!match) return null;
  return { min: Number(match[1]), max: Number(match[2]) };
}

function inferChannels(prompt) {
  const p = prompt.toLowerCase();
  const channels = [];
  if (p.includes('email')) channels.push('email');
  if (p.includes('linkedin')) channels.push('linkedin');
  if (p.includes('sms') || p.includes('text')) channels.push('sms');
  return channels.length ? channels : ['email'];
}

function inferSendPolicy(prompt) {
  const p = prompt.toLowerCase();
  return p.includes('autopilot') || p.includes('automatically') || p.includes('auto send') ? 'autopilot' : 'supervised';
}

function inferIntentThreshold(prompt) {
  const heat = prompt.match(/(?:heat|intent)\s*(?:of|>=|at least)?\s*([1-5])/i);
  return heat ? Number(heat[1]) : 4;
}

function inferObjective(prompt) {
  const p = prompt.toLowerCase();
  if (p.includes('book') && (p.includes('call') || p.includes('meeting'))) return 'book_meetings';
  if (p.includes('pipeline')) return 'generate_pipeline';
  if (p.includes('close') || p.includes('sales')) return 'close_sales';
  return 'book_meetings';
}

function inferSuccessEvent(objective) {
  if (objective === 'close_sales') return 'opportunity_won';
  if (objective === 'generate_pipeline') return 'opportunity_created';
  return 'meeting_booked';
}

function makeName({ industries, geography, objective }) {
  const who = industries[0] || 'Prospects';
  const where = geography ? ' — ' + geography : '';
  const outcome = objective === 'book_meetings' ? 'Meetings' : objective === 'close_sales' ? 'Sales' : 'Pipeline';
  return (who + ' ' + outcome + where).slice(0, 90);
}

function planCampaign(prompt, profile = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('campaign prompt is required');
  const text = String(prompt).trim();
  const objective = inferObjective(text);
  const industries = inferIndustries(text);
  const geography = inferGeography(text) || profile.targetGeography || '';
  const employees = inferEmployeeRange(text);
  const channels = inferChannels(text);
  const sendPolicy = inferSendPolicy(text);
  const intentThreshold = inferIntentThreshold(text);

  const icp = {
    industries: industries.length ? industries : (profile.icp?.industries || []),
    geography,
    employees: employees || profile.icp?.employees || null
  };

  const filters = {
    evidenceRequired: true,
    minIntentHeat: intentThreshold,
    requireReachableContact: true
  };

  const sequence = channels.map((channel, index) => ({
    step: index + 1,
    channel,
    timing: index === 0 ? 'when_eligible' : '+' + (index * 2) + 'd',
    stopOnReply: true,
    personalization: 'evidence_backed'
  }));

  return {
    name: makeName({ industries: icp.industries, geography, objective }),
    objective,
    offer: {
      name: profile.offerName || '',
      description: profile.offerDescription || ''
    },
    icp,
    filters,
    exclusions: profile.exclusions || [],
    channels,
    sequence,
    successEvent: inferSuccessEvent(objective),
    sendPolicy,
    intentThreshold,
    sourcePrompt: text
  };
}

module.exports = { planCampaign, inferIndustries, inferGeography, inferEmployeeRange, inferChannels, inferSendPolicy, inferIntentThreshold };