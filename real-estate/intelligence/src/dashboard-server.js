const express = require('express');
const { analyzeProperty } = require('./scoring');

const app = express();
app.use(express.json({ limit: '1mb' }));

const demoProperties = [
  { id: 'MIA-001', address: 'Miami Fourplex Candidate 1', askingPrice: 825000, estimatedMarketValue: 940000, estimatedRepairs: 55000, monthlyGrossRent: 9800, annualOperatingExpenses: 39000, annualDebtService: 52500, positiveCashFlow: true, motivationScore: 82, equityScore: 78, physicalConditionScore: 62, legalRiskScore: 72, marketScore: 84, dataConfidenceScore: 68 },
  { id: 'MIA-002', address: 'Miami Fourplex Candidate 2', askingPrice: 975000, estimatedMarketValue: 1025000, estimatedRepairs: 25000, monthlyGrossRent: 10500, annualOperatingExpenses: 43000, annualDebtService: 62000, positiveCashFlow: true, motivationScore: 60, equityScore: 65, physicalConditionScore: 80, legalRiskScore: 86, marketScore: 88, dataConfidenceScore: 75 },
  { id: 'MIA-003', address: 'Miami Fourplex Candidate 3', askingPrice: 690000, estimatedMarketValue: 900000, estimatedRepairs: 140000, monthlyGrossRent: 8600, annualOperatingExpenses: 41000, annualDebtService: 45000, positiveCashFlow: true, motivationScore: 90, equityScore: 88, physicalConditionScore: 38, legalRiskScore: 54, marketScore: 76, dataConfidenceScore: 58 },
  { id: 'MIA-004', address: 'Miami Fourplex Candidate 4', askingPrice: 1100000, estimatedMarketValue: 1150000, estimatedRepairs: 15000, monthlyGrossRent: 11300, annualOperatingExpenses: 46500, annualDebtService: 69000, positiveCashFlow: false, motivationScore: 45, equityScore: 52, physicalConditionScore: 88, legalRiskScore: 90, marketScore: 91, dataConfidenceScore: 82 },
  { id: 'MIA-005', address: 'Miami Fourplex Candidate 5', askingPrice: 760000, estimatedMarketValue: 980000, estimatedRepairs: 70000, monthlyGrossRent: 9500, annualOperatingExpenses: 40000, annualDebtService: 49000, positiveCashFlow: true, motivationScore: 86, equityScore: 84, physicalConditionScore: 65, legalRiskScore: 75, marketScore: 80, dataConfidenceScore: 72 },
];

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lion Elite Real Estate Intelligence</title><style>
  body{font-family:Inter,Arial,sans-serif;background:#0b0d10;color:#f5f5f5;margin:0}.wrap{max-width:1200px;margin:auto;padding:32px}.hero{display:flex;justify-content:space-between;align-items:end;gap:20px}.muted{color:#aeb4be}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;margin-top:28px}.card{background:#151922;border:1px solid #2a303b;border-radius:16px;padding:20px}.score{font-size:42px;font-weight:800}.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#272d38;font-size:12px}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.metric{background:#0f1217;padding:10px;border-radius:10px}.label{font-size:11px;color:#9da5b1;text-transform:uppercase}.value{font-size:18px;font-weight:700;margin-top:3px}.bar{height:8px;background:#242a33;border-radius:8px;overflow:hidden;margin-top:8px}.fill{height:100%;background:#e7b84b}.danger{color:#ff8080}.actions{margin-top:18px}button{background:#e7b84b;border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:25px;background:#151922;border-radius:14px;overflow:hidden}th,td{text-align:left;padding:12px;border-bottom:1px solid #2a303b}th{color:#aeb4be;font-size:12px;text-transform:uppercase}</style></head><body><div class="wrap"><div class="hero"><div><div class="pill">Lion Elite Intelligence</div><h1>Miami Multifamily Deal Room</h1><p class="muted">Rank opportunities, identify missing facts, and block unsafe acquisitions before capital is committed.</p></div><button onclick="loadDeals()">Refresh analysis</button></div><div id="cards" class="grid"></div><div id="table"></div></div><script>
  const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n||0);
  async function loadDeals(){const r=await fetch('/api/deals');const deals=await r.json();document.getElementById('cards').innerHTML=deals.map(d=>`<section class="card"><div class="pill">${d.recommendation}</div><h2>${d.address}</h2><div class="score">${d.score}</div><div class="bar"><div class="fill" style="width:${d.score}%"></div></div><div class="metrics"><div class="metric"><div class="label">NOI</div><div class="value">${money(d.economics.noi)}</div></div><div class="metric"><div class="label">Cap rate</div><div class="value">${(d.economics.capRate*100).toFixed(2)}%</div></div><div class="metric"><div class="label">DSCR</div><div class="value">${d.economics.dscr??'N/A'}</div></div><div class="metric"><div class="label">All-in basis</div><div class="value">${money(d.economics.allInBasis)}</div></div></div><p class="muted">Missing critical facts: ${d.missingCriticalFacts.length}</p>${d.dealKillers.length?`<p class="danger">${d.dealKillers.join(' • ')}</p>`:''}</section>`).join('');
  document.getElementById('table').innerHTML=`<table><thead><tr><th>Rank</th><th>Property</th><th>Score</th><th>Decision</th><th>NOI</th><th>DSCR</th><th>Missing facts</th></tr></thead><tbody>${deals.map((d,i)=>`<tr><td>${i+1}</td><td>${d.address}</td><td>${d.score}</td><td>${d.recommendation}</td><td>${money(d.economics.noi)}</td><td>${d.economics.dscr??'N/A'}</td><td>${d.missingCriticalFacts.length}</td></tr>`).join('')}</tbody></table>`}
  loadDeals();
</script></body></html>`;
}

app.get('/', (_req, res) => res.type('html').send(html()));
app.get('/api/deals', (_req, res) => res.json(demoProperties.map((property) => analyzeProperty(property)).sort((a, b) => b.score - a.score)));
app.post('/api/analyze', (req, res) => {
  try { res.json(analyzeProperty(req.body)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

const port = Number(process.env.REAL_ESTATE_PORT || 3035);
if (require.main === module) app.listen(port, () => console.log(`Real estate dashboard: http://localhost:${port}`));
module.exports = { app, demoProperties };
