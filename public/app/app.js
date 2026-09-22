const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function planFeatures(plan) {
  const items = [];
  if (plan.seats) items.push(`${plan.seats} seat${plan.seats === 1 ? '' : 's'}`);
  if (plan.clientWorkspaces) items.push(`${plan.clientWorkspaces} workspace${plan.clientWorkspaces === 1 ? '' : 's'}`);
  if (plan.dataCredits) items.push(`${plan.dataCredits.toLocaleString()} data credits`);
  if (plan.actionCredits) items.push(`${plan.actionCredits.toLocaleString()} action credits`);
  if (plan.channelConnections) items.push(`${plan.channelConnections} channel connections`);
  if (plan.whiteLabel) items.push('White label');
  if (plan.mcpApi) items.push('MCP / API');
  if (plan.auditLogs) items.push('Audit logs');
  if (plan.premiumModels) items.push('Premium AI models');
  return items;
}

async function loadPlans() {
  const grid = document.getElementById('plan-grid');
  try {
    const response = await fetch('/api/platform/plans');
    if (!response.ok) throw new Error('plans unavailable');
    const { plans } = await response.json();
    grid.innerHTML = plans.map((plan) => {
      const featured = plan.id === 'agency' ? ' featured' : '';
      const price = plan.monthlyPrice === null ? 'Custom' : currency.format(plan.monthlyPrice);
      const cadence = plan.monthlyPrice === null ? 'Talk to us' : '/ month';
      return `
        <article class="plan${featured}">
          ${plan.id === 'agency' ? '<span class="popular">MOST POPULAR</span>' : ''}
          <h4>${plan.name}</h4>
          <div class="price"><strong>${price}</strong><span>${cadence}</span></div>
          <ul>${planFeatures(plan).map(item => `<li>✓ ${item}</li>`).join('')}</ul>
          <button class="${plan.id === 'agency' ? 'primary' : 'ghost'}">${plan.id === 'enterprise' ? 'Contact sales' : 'Start building'}</button>
        </article>`;
    }).join('');
  } catch (_error) {
    grid.innerHTML = '<div class="loading">Plans are temporarily unavailable.</div>';
  }
}

loadPlans();
