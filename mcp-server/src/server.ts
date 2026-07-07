import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);

function jsonResponse(data: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function metaGet(path: string, params: Record<string, string> = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  const version = process.env.META_API_VERSION || 'v20.0';

  if (!token) {
    return { error: 'META_ACCESS_TOKEN is not configured.' };
  }

  const url = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('access_token', token);

  const response = await fetch(url);
  const body = await response.json();

  if (!response.ok) {
    return { error: 'Meta API request failed.', details: body };
  }

  return body;
}

async function getMetaAdsSummary() {
  const adAccountId = process.env.META_AD_ACCOUNT_ID;

  if (!adAccountId) {
    return { error: 'META_AD_ACCOUNT_ID is not configured.' };
  }

  return metaGet(`${adAccountId}/insights`, {
    fields: 'campaign_name,spend,impressions,clicks,ctr,cpc,actions',
    date_preset: 'yesterday',
    level: 'campaign',
  });
}

async function getGa4Summary() {
  return {
    status: 'not_implemented',
    message: 'GA4 integration placeholder. Add Google Analytics Data API client here after service credentials are configured.',
  };
}

async function getSearchConsoleSummary() {
  return {
    status: 'not_implemented',
    message: 'Search Console integration placeholder. Add Search Console API client here after credentials are configured.',
  };
}

async function getCrmPipelineSummary() {
  return {
    status: 'not_implemented',
    message: 'CRM integration placeholder. Connect the CRM API or Google Sheet lead tracker here.',
  };
}

async function getGithubPriorityTasks() {
  return {
    status: 'not_implemented',
    message: 'GitHub task integration placeholder. Add GitHub REST search for open priority issues.',
    repo: process.env.GITHUB_REPO || 'lionelite/lion-elite-os',
  };
}

async function getDailyExecutiveBrief() {
  const [meta, ga4, gsc, crm, github] = await Promise.all([
    getMetaAdsSummary(),
    getGa4Summary(),
    getSearchConsoleSummary(),
    getCrmPipelineSummary(),
    getGithubPriorityTasks(),
  ]);

  return {
    date: new Date().toISOString(),
    goal: '$100k/month revenue',
    meta_ads: meta,
    google_analytics: ga4,
    search_console: gsc,
    crm_pipeline: crm,
    github_tasks: github,
    recommended_focus: [
      'Review ad spend and lead quality.',
      'Identify best-performing content themes.',
      'Build the next marketing asset tied to the strongest funnel.',
      'Update GitHub with the next execution task.',
    ],
  };
}

const tools = {
  get_meta_ads_summary: getMetaAdsSummary,
  get_ga4_summary: getGa4Summary,
  get_search_console_summary: getSearchConsoleSummary,
  get_crm_pipeline_summary: getCrmPipelineSummary,
  get_github_priority_tasks: getGithubPriorityTasks,
  get_daily_executive_brief: getDailyExecutiveBrief,
};

app.get('/health', (_req, res) => {
  res.json({ ok: true, name: 'lion-elite-business-mcp' });
});

app.get('/tools', (_req, res) => {
  res.json({ tools: Object.keys(tools) });
});

app.post('/call-tool', async (req, res) => {
  const name = req.body?.name as keyof typeof tools;

  if (!name || !tools[name]) {
    res.status(400).json({ error: 'Unknown tool name.', available_tools: Object.keys(tools) });
    return;
  }

  try {
    const result = await tools[name]();
    res.json(jsonResponse(result));
  } catch (error) {
    res.status(500).json({ error: 'Tool execution failed.', details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Lion Elite Business MCP listening on port ${PORT}`);
});
