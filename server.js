const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const agents = [
  {
    id: 'marketing',
    name: 'Marketing Agent',
    mission: 'Create daily content, captions, hooks, CTAs, carousel outlines, reel scripts, and campaign plans.',
    activation: 'Run when Lion Elite needs content, campaigns, ads, email angles, or daily posting assets.',
    dailyOutputs: ['3 captions', '3 reel hooks', '1 carousel outline', '1 story CTA', '1 cross-brand content idea'],
    tools: ['GitHub content files', 'Brand rules', 'Caption bank', 'KPI scoreboard'],
    systemPrompt: 'You are the Lion Elite Marketing Agent. Create direct, premium, conversion-focused marketing outputs. Respect the brand split: Lion Elite Wellness is research education only; Lion Elite Beauty is coaching, beauty, transformation and client programs; AlexTheLionLifts is personal credibility, training, discipline, and coaching. Always include hook, value, CTA, platform, and brand target.'
  },
  {
    id: 'sales',
    name: 'Sales Agent',
    mission: 'Turn leads into conversations, consultations, and customers through DM, SMS, email, and call follow-up.',
    activation: 'Run when a lead comments, DMs, books, misses a meeting, objects, or needs a follow-up.',
    dailyOutputs: ['5 warm lead follow-ups', '3 SMS messages', '1 objection response', '1 close script', '1 reactivation message'],
    tools: ['Gmail drafts', 'DM scripts', 'Call recap templates', 'Sales framework'],
    systemPrompt: 'You are the Lion Elite Sales Agent. Use the framework Engage → Power Statement → Identify → Build Value → Handle Objection → Close → Follow Up. Messages must be short enough for DM/SMS when requested. Always end with a question. Build value before price.'
  },
  {
    id: 'operations',
    name: 'Operations Agent',
    mission: 'Turn repeated business work into SOPs, checklists, issues, dashboards, and team-ready workflows.',
    activation: 'Run when a process repeats twice, a task gets messy, or a team member needs instructions.',
    dailyOutputs: ['1 SOP', '1 checklist', '1 GitHub issue', '1 bottleneck note', '1 workflow improvement'],
    tools: ['GitHub SOPs', 'Operations folder', 'Weekly review', 'Fulfillment checklists'],
    systemPrompt: 'You are the Lion Elite Operations Agent. Turn messy repeated work into clear SOPs, checklists, owners, triggers, quality checks, and next improvements. Prioritize execution over explanation.'
  },
  {
    id: 'research-compliance',
    name: 'Research Compliance Agent',
    mission: 'Keep Lion Elite Wellness research-use-only content safe, educational, and compliant.',
    activation: 'Run before publishing Lion Elite Wellness product, peptide, research, or educational content.',
    dailyOutputs: ['1 content review', '1 safer rewrite', '1 disclaimer check', '1 approved education idea'],
    tools: ['Compliance language', 'Research disclaimers', 'Wellness brand rules'],
    systemPrompt: 'You are the Lion Elite Research Compliance Agent. For Lion Elite Wellness, keep content research-use-only. Do not provide dosing, human-use instructions, disease claims, treatment claims, or transformation promises. Rewrite risky copy into research-safe educational language. Include risk level, problem phrase, safer replacement, and final version.'
  },
  {
    id: 'finance-kpi',
    name: 'Finance & KPI Agent',
    mission: 'Track the numbers that matter and turn them into daily revenue priorities.',
    activation: 'Run at the start and end of each business day or after new sales/performance data is added.',
    dailyOutputs: ['Daily scorecard', '1 KPI insight', '1 revenue action', '1 risk warning', '1 CEO question'],
    tools: ['KPI scoreboard', 'Sales data', 'Marketing metrics', 'Revenue targets'],
    systemPrompt: 'You are the Lion Elite Finance & KPI Agent. Translate numbers into daily action. Focus on revenue, orders, DMs, consultations, content performance, average order value, and the $100k/month target. Always end with one CEO priority question.'
  }
];

const commandCenter = {
  priority: 'AI agents first. Build Lion Elite OS around automation, not just a website.',
  mode: process.env.OPENAI_API_KEY ? 'AI-powered' : 'Template fallback',
  nextBuilds: [
    'Add OPENAI_API_KEY in Render environment variables to activate AI-powered generations.',
    'Save approved agent outputs to GitHub files.',
    'Connect Gmail for draft follow-ups and recap emails.',
    'Connect Calendar for consultations and daily schedule.',
    'Add KPI input form for revenue, orders, DMs, and content metrics.',
    'Add authentication before private business data is entered.'
  ],
  operatingRule: 'Every agent must produce a usable business output: content, follow-up, SOP, compliance rewrite, or KPI action.'
};

function findAgent(id) {
  return agents.find(item => item.id === id);
}

function fallbackRunAgent(id, context = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const topic = context.topic || 'daily execution';
  const brand = context.brand || 'Lion Elite';

  const outputs = {
    marketing: {
      title: 'Daily Marketing Output',
      summary: `Create content for ${brand} around ${topic}.`,
      items: [
        { type: 'Caption', output: `Discipline creates momentum. ${brand} is built on daily execution, not random motivation. CTA: DM ELITE if you are ready to build with intention.` },
        { type: 'Reel Hook', output: 'Most people do not need more ideas. They need a system that makes the right action obvious every day.' },
        { type: 'Carousel', output: 'Slide 1: Stop guessing. Slide 2: Track leads. Slide 3: Track conversations. Slide 4: Track conversions. Slide 5: Double down on what works. Slide 6: Execute daily. Slide 7: DM ELITE.' }
      ],
      nextAction: 'Choose one post and publish it today.'
    },
    sales: {
      title: 'Daily Sales Output',
      summary: `Follow up with warm leads for ${brand}.`,
      items: [
        { type: 'DM Follow-up', output: 'Hey, I saw you were interested. The next step is simple: we map your goal, identify what is holding you back, and build the plan. Are you looking to start this week or next week?' },
        { type: 'Objection Response', output: 'I understand. The reason I recommend starting with a plan is because guessing usually costs more time and money. Want me to show you what the first step would look like?' },
        { type: 'Close', output: 'The process is three steps: establish the plan, personalize the execution, and capitalize with ongoing support. Do you want me to get your application started?' }
      ],
      nextAction: 'Send one follow-up to a warm lead now.'
    },
    operations: {
      title: 'Daily Operations Output',
      summary: `Systemize one repeated task around ${topic}.`,
      items: [
        { type: 'SOP Trigger', output: 'If the same task happens twice, document it before doing it a third time.' },
        { type: 'Checklist', output: 'Define owner → define trigger → write steps → add quality check → store in GitHub → review weekly.' },
        { type: 'Bottleneck', output: 'Unwritten processes slow down marketing, fulfillment, and follow-up. The fix is one checklist per repeated workflow.' }
      ],
      nextAction: 'Pick one repeated task and turn it into a checklist.'
    },
    'research-compliance': {
      title: 'Research Compliance Output',
      summary: 'Review Wellness-style content for research-safe language.',
      items: [
        { type: 'Safe Phrase', output: 'Investigational research compound studied in controlled laboratory models.' },
        { type: 'Avoid', output: 'Avoid dosing, human-use instructions, treatment claims, disease claims, or transformation promises for research products.' },
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
        { type: 'CEO Question', output: 'Which activity today has the highest chance of creating revenue in the next 24 hours?' }
      ],
      nextAction: 'Enter today’s DMs, orders, consultations, and revenue.'
    }
  };

  return {
    date: today,
    mode: 'template-fallback',
    agent: findAgent(id),
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
        { role: 'system', content: `${agent.systemPrompt}\n\nReturn a practical business output. Use headings and bullets. Keep it direct and ready to use.` },
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
    agent,
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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lion-elite-os', mode: commandCenter.mode, timestamp: new Date().toISOString() });
});

app.get('/api/os', (req, res) => {
  res.json({
    name: 'Lion Elite OS',
    mission: 'Automate the Lion Elite business ecosystem through specialized AI agents.',
    commandCenter,
    agents: agents.map(({ systemPrompt, ...agent }) => agent)
  });
});

app.get('/api/agents', (req, res) => {
  res.json({ agents: agents.map(({ systemPrompt, ...agent }) => agent) });
});

app.get('/api/agents/:id', (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { systemPrompt, ...safeAgent } = agent;
  res.json({ agent: safeAgent });
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
