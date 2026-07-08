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
    tools: ['GitHub content files', 'Brand rules', 'Caption bank', 'KPI scoreboard']
  },
  {
    id: 'sales',
    name: 'Sales Agent',
    mission: 'Turn leads into conversations, consultations, and customers through DM, SMS, email, and call follow-up.',
    activation: 'Run when a lead comments, DMs, books, misses a meeting, objects, or needs a follow-up.',
    dailyOutputs: ['5 warm lead follow-ups', '3 SMS messages', '1 objection response', '1 close script', '1 reactivation message'],
    tools: ['Gmail drafts', 'DM scripts', 'Call recap templates', 'Sales framework']
  },
  {
    id: 'operations',
    name: 'Operations Agent',
    mission: 'Turn repeated business work into SOPs, checklists, issues, dashboards, and team-ready workflows.',
    activation: 'Run when a process repeats twice, a task gets messy, or a team member needs instructions.',
    dailyOutputs: ['1 SOP', '1 checklist', '1 GitHub issue', '1 bottleneck note', '1 workflow improvement'],
    tools: ['GitHub SOPs', 'Operations folder', 'Weekly review', 'Fulfillment checklists']
  },
  {
    id: 'research-compliance',
    name: 'Research Compliance Agent',
    mission: 'Keep Lion Elite Wellness research-use-only content safe, educational, and compliant.',
    activation: 'Run before publishing Lion Elite Wellness product, peptide, research, or educational content.',
    dailyOutputs: ['1 content review', '1 safer rewrite', '1 disclaimer check', '1 approved education idea'],
    tools: ['Compliance language', 'Research disclaimers', 'Wellness brand rules']
  },
  {
    id: 'finance-kpi',
    name: 'Finance & KPI Agent',
    mission: 'Track the numbers that matter and turn them into daily revenue priorities.',
    activation: 'Run at the start and end of each business day or after new sales/performance data is added.',
    dailyOutputs: ['Daily scorecard', '1 KPI insight', '1 revenue action', '1 risk warning', '1 CEO question'],
    tools: ['KPI scoreboard', 'Sales data', 'Marketing metrics', 'Revenue targets']
  }
];

const commandCenter = {
  priority: 'AI agents first. Build Lion Elite OS around automation, not just a website.',
  nextBuilds: [
    'Add agent run buttons in the dashboard.',
    'Add a daily agent output page.',
    'Add saved outputs to GitHub files.',
    'Connect Gmail for draft follow-ups and recap emails.',
    'Connect Calendar for consultations and daily schedule.',
    'Add KPI input form for revenue, orders, DMs, and content metrics.'
  ],
  operatingRule: 'Every agent must produce a usable business output: content, follow-up, SOP, compliance rewrite, or KPI action.'
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lion-elite-os', timestamp: new Date().toISOString() });
});

app.get('/api/os', (req, res) => {
  res.json({
    name: 'Lion Elite OS',
    mission: 'Automate the Lion Elite business ecosystem through specialized AI agents.',
    commandCenter,
    agents
  });
});

app.get('/api/agents', (req, res) => {
  res.json({ agents });
});

app.get('/api/agents/:id', (req, res) => {
  const agent = agents.find(item => item.id === req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agent });
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
