const express = require('express');
const path = require('path');
const { leadAutomationReadiness } = require('./lib/lead-automation-readiness');
const { MemoryCoachingStore, PostgresCoachingStore } = require('./lib/coaching/store');
const { createPushService } = require('./lib/coaching/push');
const { createCoachingRouter } = require('./routes/coaching');
const { createLeadsRouter } = require('./routes/leads');
const leadStore = require('./lib/leads/lead-store');
const { createCheckoutRouter } = require('./routes/checkout');

const app = express();
const port = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
// The raw bytes are kept so the Stripe webhook can verify its signature; the
// signature is computed over exactly what was sent, not over a re-serialized
// copy of the parsed object.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => { req.rawBody = buffer; }
}));
const coachingStore = process.env.COACHING_DEMO_MODE === 'true'
  ? new MemoryCoachingStore()
  : new PostgresCoachingStore();
const coachingPush = createPushService(coachingStore);
app.use('/api/coaching', createCoachingRouter({ store: coachingStore, pushService: coachingPush }));
// Payment. Paying creates a coaching client, which is what sends the invite
// email, so a completed checkout ends with the customer able to log in.
app.use('/api/checkout', createCheckoutRouter({ store: coachingStore }));
// Public B2C opt-in. The only path by which a consumer or coach enters the
// marketing pipeline, because it is the only one where they consent.
app.use('/api/leads', createLeadsRouter({ store: leadStore }));
app.use('/coaching', (_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
      "img-src 'self' data:",
      "manifest-src 'self'",
      "media-src 'self' https:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self'"
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const customerCommunicationRules = [
  'All customer-facing emails, DMs, SMS, and follow-ups must sound human, warm, relationship-building, and customer-service focused. Do not sound robotic, scripted, pushy, or corporate.',
  'Lead with care, clarity, and personal attention before selling. Make the customer feel guided, not processed.',
  'Keep messages conversational and natural. Use simple language, short paragraphs, and a tone that feels like a real person helping them.',
  'Do not send internal inventory, exact inventory lists, product counts, unit quantities, batch details, source-sheet details, or internal notes to customers or leads.',
  'For customer-facing availability language, only say limited stock, current availability is limited, or I can confirm current availability for you.',
  'If a product is out of stock, do not advertise it as available. Offer to confirm availability, suggest joining the waitlist, or guide them to the right next step.',
  'For Lion Elite Wellness, keep all product language research-use-only and do not include dosing, human-use instructions, disease claims, treatment claims, or transformation promises.'
];

function communicationRulesText() {
  return customerCommunicationRules.map(rule => `- ${rule}`).join('\n');
}

const agents = [
  {
    id: 'executive',
    name: 'Executive Agent',
    mission: 'Coordinate all Lion Elite agents into one clear CEO action plan.',
    activation: 'Run at the start of the day, after running multiple agents, or when Alex needs the next best move.',
    dailyOutputs: ['CEO priority', 'agent assignments', 'revenue action', 'risk warning', 'next 3 moves'],
    tools: ['All agent outputs', 'KPI scoreboard', 'brand rules', 'daily priorities'],
    systemPrompt: 'You are the Lion Elite Executive Agent. You coordinate the Marketing, Sales, Operations, Research Compliance, and Finance/KPI agents. Your job is to turn all information into a clear CEO action plan. Be direct. Give priorities, order of execution, and the next 3 moves. Focus on revenue, lead generation, consistency, compliance, operational leverage, customer trust, and relationship-building communication.'
  },
  {
    id: 'marketing',
    name: 'Marketing Agent',
    mission: 'Create daily content, captions, hooks, CTAs, carousel outlines, reel scripts, and campaign plans.',
    activation: 'Run when Lion Elite needs content, campaigns, ads, email angles, or daily posting assets.',
    dailyOutputs: ['3 captions', '3 reel hooks', '1 carousel outline', '1 story CTA', '1 cross-brand content idea'],
    tools: ['GitHub content files', 'Brand rules', 'Caption bank', 'KPI scoreboard'],
    systemPrompt: 'You are the Lion Elite Marketing Agent. Create direct, premium, conversion-focused marketing outputs. Respect the brand split: Lion Elite Wellness is research education only; Lion Elite Beauty is coaching, beauty, transformation and client programs; AlexTheLionLifts is personal credibility, training, discipline, and coaching. Always include hook, value, CTA, platform, and brand target. For emails, DMs, and customer follow-ups, write human, warm, relationship-building copy that feels like real customer service. Never reveal exact inventory, product counts, units, batch details, or internal inventory notes; customer-facing availability language may only say limited stock or current availability is limited.'
  },
  {
    id: 'sales',
    name: 'Sales Agent',
    mission: 'Turn leads into conversations, consultations, and customers through DM, SMS, email, and call follow-up.',
    activation: 'Run when a lead comments, DMs, books, misses a meeting, objects, or needs a follow-up.',
    dailyOutputs: ['5 warm lead follow-ups', '3 SMS messages', '1 objection response', '1 close script', '1 reactivation message'],
    tools: ['Gmail drafts', 'DM scripts', 'Call recap templates', 'Sales framework'],
    systemPrompt: 'You are the Lion Elite Sales Agent. Use the framework Engage → Power Statement → Identify → Build Value → Handle Objection → Close → Follow Up, but do not sound scripted. Customer-facing messages must feel human, warm, relationship-building, and service-first. Build trust before asking for the sale. Messages must be short enough for DM/SMS when requested. Always end with a natural question. Build value before price. Never send internal inventory, exact product counts, unit quantities, batch details, or source-sheet details to customers. If availability matters, only say limited stock or current availability is limited, then offer to confirm what is available for them.'
  },
  {
    id: 'operations',
    name: 'Operations Agent',
    mission: 'Turn repeated business work into SOPs, checklists, issues, dashboards, and team-ready workflows.',
    activation: 'Run when a process repeats twice, a task gets messy, or a team member needs instructions.',
    dailyOutputs: ['1 SOP', '1 checklist', '1 GitHub issue', '1 bottleneck note', '1 workflow improvement'],
    tools: ['GitHub SOPs', 'Operations folder', 'Weekly review', 'Fulfillment checklists'],
    systemPrompt: 'You are the Lion Elite Operations Agent. Turn messy repeated work into clear SOPs, checklists, owners, triggers, quality checks, and next improvements. Prioritize execution over explanation. Build guardrails that keep internal inventory private and keep customer communication warm, human, and service-first.'
  },
  {
    id: 'research-compliance',
    name: 'Research Compliance Agent',
    mission: 'Keep Lion Elite Wellness research-use-only content safe, educational, and compliant.',
    activation: 'Run before publishing Lion Elite Wellness product, peptide, research, or educational content.',
    dailyOutputs: ['1 content review', '1 safer rewrite', '1 disclaimer check', '1 approved education idea'],
    tools: ['Compliance language', 'Research disclaimers', 'Wellness brand rules'],
    systemPrompt: 'You are the Lion Elite Research Compliance Agent. For Lion Elite Wellness, keep content research-use-only. Do not provide dosing, human-use instructions, disease claims, treatment claims, or transformation promises. Rewrite risky copy into research-safe educational language. Include risk level, problem phrase, safer replacement, and final version. Also check that customer-facing content does not reveal internal inventory, exact product counts, unit quantities, batch details, source-sheet details, or internal notes. Availability language must only say limited stock or current availability is limited.'
  },
  {
    id: 'finance-kpi',
    name: 'Finance & KPI Agent',
    mission: 'Track the numbers that matter and turn them into daily revenue priorities.',
    activation: 'Run at the start and end of each business day or after new sales/performance data is added.',
    dailyOutputs: ['Daily scorecard', '1 KPI insight', '1 revenue action', '1 risk warning', '1 CEO question'],
    tools: ['KPI scoreboard', 'Sales data', 'Marketing metrics', 'Revenue targets'],
    systemPrompt: 'You are the Lion Elite Finance & KPI Agent. Translate numbers into daily action. Focus on revenue, orders, DMs, consultations, content performance, average order value, and the $100k/month target. Always end with one CEO priority question. Treat inventory quantities as internal business data, not customer-facing copy.'
  }
];

const commandCenter = {
  priority: 'AI agents first. Build Lion Elite OS around automation, not just a website.',
  mode: process.env.OPENAI_API_KEY ? 'AI-powered' : 'Template fallback',
  communicationRules: customerCommunicationRules,
  nextBuilds: [
    'Use Daily Briefing to run the full agent team and get a CEO action plan.',
    'Add GITHUB_TOKEN in Render environment variables to save approved outputs back to GitHub.',
    'Connect Gmail for draft follow-ups and recap emails.',
    'Connect Calendar for consultations and daily schedule.',
    'Add KPI input form for revenue, orders, DMs, and content metrics.',
    'Add authentication before private business data is entered.',
    'Add a pre-send customer communication checker for emails, DMs, SMS, and inventory-related copy.'
  ],
  operatingRule: 'Every agent must produce a usable business output while protecting internal inventory data and keeping customer communication human, relationship-building, and service-first.'
};

function findAgent(id) {
  return agents.find(item => item.id === id);
}

function safeAgent(agent) {
  if (!agent) return null;
  const { systemPrompt, ...safe } = agent;
  return safe;
}

function fallbackRunAgent(id, context = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const topic = context.topic || 'daily execution';
  const brand = context.brand || 'Lion Elite';

  const outputs = {
    executive: {
      title: 'CEO Action Plan',
      summary: `Coordinate today's execution for ${brand} around ${topic}.`,
      items: [
        { type: 'CEO Priority', output: 'Focus on the action most likely to create leads, conversations, consultations, or revenue today while protecting customer trust.' },
        { type: 'Agent Assignments', output: 'Marketing creates demand. Sales follows up warmly. Operations documents the process. Finance tracks the score. Compliance reviews Wellness copy and inventory privacy.' },
        { type: 'Next 3 Moves', output: '1) Publish one lead-generating post. 2) Follow up with warm leads using relationship-first language. 3) Track DMs, calls, orders, and revenue before the day ends.' }
      ],
      nextAction: 'Run Marketing and Sales first, then execute the highest revenue action.'
    },
    marketing: {
      title: 'Daily Marketing Output',
      summary: `Create content for ${brand} around ${topic}.`,
      items: [
        { type: 'Caption', output: `Real progress starts when people feel guided, not sold. ${brand} is built on trust, standards, and personal support. CTA: DM ELITE if you want help choosing the right next step.` },
        { type: 'Reel Hook', output: 'Most people do not need another cold pitch. They need someone who actually listens, guides, and helps them execute.' },
        { type: 'Customer Availability Language', output: 'Current availability is limited, but I can help confirm what makes sense before you make a decision.' }
      ],
      nextAction: 'Choose one post and publish it today.'
    },
    sales: {
      title: 'Daily Sales Output',
      summary: `Follow up with warm leads for ${brand}.`,
      items: [
        { type: 'DM Follow-up', output: 'Hey, I appreciate you reaching out. I want to make sure I point you in the right direction instead of just throwing information at you. What goal are you focused on right now?' },
        { type: 'Objection Response', output: 'I understand. I would rather help you make a clear decision than pressure you into anything. Want me to walk you through what the first step would look like?' },
        { type: 'Limited Stock Note', output: 'Current availability is limited, so I can confirm what makes sense before you move forward. What are you looking for help with first?' }
      ],
      nextAction: 'Send one warm, human follow-up to a real lead now.'
    },
    operations: {
      title: 'Daily Operations Output',
      summary: `Systemize one repeated task around ${topic}.`,
      items: [
        { type: 'SOP Trigger', output: 'If the same task happens twice, document it before doing it a third time.' },
        { type: 'Checklist', output: 'Define owner → define trigger → write steps → add quality check → protect internal data → store in GitHub → review weekly.' },
        { type: 'Bottleneck', output: 'Unwritten processes slow down marketing, fulfillment, and follow-up. The fix is one checklist per repeated workflow.' }
      ],
      nextAction: 'Pick one repeated task and turn it into a checklist.'
    },
    'research-compliance': {
      title: 'Research Compliance Output',
      summary: 'Review Wellness-style content for research-safe language and inventory privacy.',
      items: [
        { type: 'Safe Phrase', output: 'Investigational research compound studied in controlled laboratory models.' },
        { type: 'Avoid', output: 'Avoid dosing, human-use instructions, treatment claims, disease claims, transformation promises, exact inventory counts, batch details, or internal inventory lists.' },
        { type: 'Disclaimer', output: 'For laboratory research purposes only. Not for human or veterinary use.' }
      ],
      nextAction: 'Run Wellness content through this agent before publishing.'
    },
    'finance-kpi': {
      title: 'Finance & KPI Output',
      summary: 'Turn business metrics into today\'s revenue priority.',
      items: [
        { type: 'Scorecard', output: 'Track DMs, consultations booked, orders, revenue, content posted, and top CTA.' },
        { type: 'Revenue Math', output: '$100,000/month requires about $3,333/day. The daily question: what creates qualified leads, orders, or repeat buyers today?' },
        { type: 'CEO Question', output: 'Which activity today has the highest chance of creating revenue in the next 24 hours while protecting customer trust?' }
      ],
      nextAction: 'Enter today’s DMs, orders, consultations, and revenue.'
    }
  };

  return {
    date: today,
    mode: 'template-fallback',
    agent: safeAgent(findAgent(id)),
    context: { brand, topic },
    result: outputs[id]
  };
}

async function runAgent(id, context = {}) {
  const agent = findAgent(id);
  if (!process.env.OPENAI_API_KEY) {
    return fallbackRunAgent(id, context);
  }

  const today = new Date().toISOString().slice(0, 10);
  const brand = context.brand || 'Lion Elite';
  const topic = context.topic || 'daily execution';
  const userTask = context.task || `Create today's agent output for brand: ${brand}. Topic/task: ${topic}.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: `${agent.systemPrompt}\n\nCustomer Communication Rules:\n${communicationRulesText()}\n\nReturn a practical business output. Use headings and bullets. Keep it direct and ready to use. Customer-facing copy must sound human and service-first, not robotic. Never expose internal inventory details; only mention limited stock/current availability when needed.` },
        { role: 'user', content: userTask }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ...fallbackRunAgent(id, context), mode: 'template-fallback-after-openai-error', openaiError: errorText };
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || 'No output returned.';

  return {
    date: today,
    mode: 'ai-powered',
    agent: safeAgent(agent),
    context: { brand, topic, task: userTask },
    result: {
      title: `${agent.name} AI Output`,
      summary: `AI-generated output for ${brand} around ${topic}.`,
      text,
      items: [{ type: 'AI Output', output: text }],
      nextAction: 'Review, edit if needed, then execute or save.'
    }
  };
}

async function runDailyBriefing(context = {}) {
  const brand = context.brand || 'Lion Elite Beauty';
  const topic = context.topic || 'daily lead generation';
  const baseTask = context.task || 'Create the next best actions to produce leads, conversations, consultations, or revenue today.';
  const runIds = ['marketing', 'sales', 'operations', 'research-compliance', 'finance-kpi'];
  const runs = [];

  for (const id of runIds) {
    const agent = findAgent(id);
    const task = `${baseTask}\n\nYou are contributing to a full daily CEO briefing. Brand: ${brand}. Topic: ${topic}. Give your most useful output for today while following the customer communication rules and inventory privacy rules.`;
    runs.push(await runAgent(id, { brand, topic, task }));
  }

  const briefingText = runs.map(run => `${run.agent.name}:\n${run.result.text || run.result.items.map(item => `${item.type}: ${item.output}`).join('\n')}`).join('\n\n---\n\n');
  const executiveTask = `Create a concise CEO briefing from these agent outputs. Give: 1) top priority, 2) today's exact execution order, 3) revenue action, 4) content to post, 5) follow-up to send, 6) risk to watch, 7) next 3 moves. Make all customer-facing copy warm, human, relationship-building, and service-first. Do not reveal internal inventory or exact product quantities; only use limited stock/current availability language.\n\n${briefingText}`;
  const executive = await runAgent('executive', { brand, topic, task: executiveTask });

  return {
    date: new Date().toISOString().slice(0, 10),
    mode: commandCenter.mode,
    context: { brand, topic, task: baseTask },
    executive,
    runs
  };
}

function slugify(value) {
  return String(value || 'output')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'output';
}

function markdownFromRun(run) {
  const body = run.result?.text || (run.result?.items || []).map(item => `## ${item.type}\n${item.output}`).join('\n\n');
  return `# ${run.agent?.name || 'Agent'} Output\n\nDate: ${run.date || new Date().toISOString().slice(0, 10)}\nMode: ${run.mode || 'unknown'}\nBrand: ${run.context?.brand || 'N/A'}\nTopic: ${run.context?.topic || 'N/A'}\n\n## Summary\n${run.result?.summary || ''}\n\n## Output\n${body}\n\n## Next Action\n${run.result?.nextAction || ''}\n`;
}

async function saveRunToGitHub(run) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is not configured in Render environment variables.');
  }

  const repo = process.env.GITHUB_REPO || 'lionelite/lion-elite-os';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const date = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const agentId = slugify(run.agent?.id || run.agent?.name || 'agent');
  const topic = slugify(run.context?.topic || 'output');
  const filePath = `agent-outputs/${date}/${agentId}-${topic}-${stamp}.md`;
  const content = markdownFromRun(run);

  const response = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'lion-elite-os'
    },
    body: JSON.stringify({
      message: `Save ${run.agent?.name || 'agent'} output`,
      content: Buffer.from(content).toString('base64'),
      branch
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message || 'GitHub save failed.');
  }

  return {
    repo,
    branch,
    path: filePath,
    url: data.content?.html_url,
    commit: data.commit?.sha
  };
}

// Render sets RENDER_GIT_COMMIT on every deploy. Reporting it lets CI confirm
// that the commit it just merged is the one actually serving traffic, which a
// deploy hook's 200 does not tell anyone.
const DEPLOYED_COMMIT = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'lion-elite-os',
    mode: commandCenter.mode,
    commit: DEPLOYED_COMMIT,
    leadAutomation: leadAutomationReadiness(),
    // Booleans only — never the credential values themselves. Answers "is the
    // listener running and are its leads being kept" without a dashboard.
    bluesky: {
      listenerEnabled: String(process.env.BLUESKY_LISTENER_ENABLED || 'true').toLowerCase() !== 'false',
      durableLeadStorage: Boolean(process.env.DATABASE_URL),
      replyWorkerEnabled: String(process.env.BLUESKY_OUTREACH_ENABLED || '').toLowerCase() === 'true'
        && Boolean(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD)
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/api/integrations', (req, res) => {
  res.json({
    openai: Boolean(process.env.OPENAI_API_KEY),
    githubSave: Boolean(process.env.GITHUB_TOKEN),
    githubRepo: process.env.GITHUB_REPO || 'lionelite/lion-elite-os',
    mode: commandCenter.mode
  });
});

app.get('/api/os', (req, res) => {
  res.json({
    name: 'Lion Elite OS',
    mission: 'Automate the Lion Elite business ecosystem through specialized AI agents.',
    commandCenter,
    agents: agents.map(safeAgent)
  });
});

app.get('/api/agents', (req, res) => {
  res.json({ agents: agents.map(safeAgent) });
});

app.get('/api/agents/:id', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agent: safeAgent(agent) });
});

app.post('/api/agents/:id/run', async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json(await runAgent(req.params.id, req.body));
  } catch (error) {
    res.status(500).json({ error: error.message, fallback: fallbackRunAgent(req.params.id, req.body) });
  }
});

app.get('/api/agents/:id/run', async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json(await runAgent(req.params.id, req.query));
  } catch (error) {
    res.status(500).json({ error: error.message, fallback: fallbackRunAgent(req.params.id, req.query) });
  }
});

app.post('/api/briefing/daily', async (req, res) => {
  try {
    res.json(await runDailyBriefing(req.body));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/outputs/save', async (req, res) => {
  try {
    if (!req.body?.run) return res.status(400).json({ error: 'Missing run payload.' });
    const saved = await saveRunToGitHub(req.body.run);
    res.json({ saved });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent-plan/today', (req, res) => {
  res.json({
    date: new Date().toISOString().slice(0, 10),
    focus: 'Activate the agents as the main business execution layer.',
    plan: agents.map(agent => ({
      agent: agent.name,
      action: agent.dailyOutputs[0],
      why: agent.mission
    }))
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Lion Elite OS agent command center running on port ${port}`);
});
