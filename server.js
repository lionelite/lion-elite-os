const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const brands = [
  {
    name: 'Lion Elite Wellness',
    role: 'Research education, operations, fulfillment, compliance, and research-use-only content.',
    focus: ['Research education', 'Product SOPs', 'Compliance language', 'Order systems']
  },
  {
    name: 'Lion Elite Beauty',
    role: 'Coaching, transformation, beauty, biomarker workflows, and client programs.',
    focus: ['Coaching offers', 'Client onboarding', 'Content funnels', 'Transformation systems']
  },
  {
    name: 'AlexTheLionLifts',
    role: 'Personal brand for credibility, coaching, training, human performance, and education.',
    focus: ['Authority content', 'Fitness coaching', 'Lifestyle reels', 'Lead generation']
  },
  {
    name: 'BUNKER',
    role: 'Premium gym and wellness ecosystem concept, investor materials, and expansion planning.',
    focus: ['Investor deck', 'Locations', 'Brand story', 'Financial model']
  }
];

const agents = [
  {
    name: 'Marketing Agent',
    mission: 'Create daily content, captions, hooks, CTAs, carousel outlines, reel scripts, and campaign plans.',
    outputs: ['Daily posts', 'Caption bank', 'Content calendar', 'Ad ideas']
  },
  {
    name: 'Sales Agent',
    mission: 'Build scripts, objection handling, lead follow-ups, DM replies, SMS sequences, and closing workflows.',
    outputs: ['Follow-up messages', 'Sales scripts', 'Objection responses', 'Lead pipeline notes']
  },
  {
    name: 'Operations Agent',
    mission: 'Turn repeated tasks into SOPs, checklists, dashboards, and execution systems.',
    outputs: ['SOPs', 'Daily task flow', 'Fulfillment checklist', 'Weekly reviews']
  },
  {
    name: 'Research Compliance Agent',
    mission: 'Keep Lion Elite Wellness language research-focused, educational, and compliant.',
    outputs: ['Research disclaimers', 'Educational copy', 'Product page language', 'Compliance review']
  },
  {
    name: 'Finance & KPI Agent',
    mission: 'Track revenue goals, content KPIs, sales performance, inventory, and weekly business numbers.',
    outputs: ['KPI scoreboard', 'Revenue math', 'Expense notes', 'Weekly review']
  }
];

const dailyWorkflow = [
  'Review yesterday’s leads, DMs, orders, content performance, and revenue.',
  'Pick the highest-leverage action for qualified leads, consultations, orders, or repeat customers.',
  'Create today’s content for each brand based on the brand split.',
  'Send or draft follow-ups for warm leads and missed opportunities.',
  'Update SOPs, checklists, or GitHub files when a repeated process appears.',
  'Track KPIs and decide what to double down on tomorrow.'
];

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'lion-elite-os', timestamp: new Date().toISOString() });
});

app.get('/api/os', (req, res) => {
  res.json({
    name: 'Lion Elite OS',
    mission: 'Automate and organize the Lion Elite business ecosystem.',
    brands,
    agents,
    dailyWorkflow
  });
});

app.get('/api/agents', (req, res) => {
  res.json({ agents });
});

app.get('/api/workflow/today', (req, res) => {
  res.json({
    date: new Date().toISOString().slice(0, 10),
    priority: 'Automate repeatable business execution across marketing, sales, operations, research compliance, and KPIs.',
    workflow: dailyWorkflow
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Lion Elite OS running on port ${port}`);
});
