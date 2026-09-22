const PLANS = Object.freeze({
  solo: Object.freeze({
    id: 'solo',
    name: 'Solo',
    monthlyPriceCents: 29900,
    annualPriceCents: 299000,
    seats: 1,
    clientWorkspaces: 1,
    dataCredits: 3000,
    actionCredits: 5000,
    channelConnections: 2,
    whiteLabel: false,
    mcpApi: true,
    auditLogs: true,
    premiumModels: false
  }),
  agency: Object.freeze({
    id: 'agency',
    name: 'Agency',
    monthlyPriceCents: 49900,
    annualPriceCents: 499000,
    seats: 5,
    clientWorkspaces: 5,
    dataCredits: 6000,
    actionCredits: 12000,
    channelConnections: 5,
    whiteLabel: true,
    mcpApi: true,
    auditLogs: true,
    premiumModels: true
  }),
  enterprise: Object.freeze({
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPriceCents: null,
    annualPriceCents: null,
    seats: null,
    clientWorkspaces: null,
    dataCredits: null,
    actionCredits: null,
    channelConnections: null,
    whiteLabel: true,
    mcpApi: true,
    auditLogs: true,
    premiumModels: true
  })
});

const ADD_ONS = Object.freeze({
  channelConnectionMonthlyCents: 1200,
  clientWorkspaceMonthlyCents: 9900,
  seatMonthlyCents: 1900
});

function publicPlan(plan) {
  return {
    ...plan,
    monthlyPrice: plan.monthlyPriceCents === null ? null : plan.monthlyPriceCents / 100,
    annualPrice: plan.annualPriceCents === null ? null : plan.annualPriceCents / 100
  };
}

function listPlans() {
  return Object.values(PLANS).map(publicPlan);
}

function getPlan(id) {
  const plan = PLANS[id];
  return plan ? publicPlan(plan) : null;
}

module.exports = { PLANS, ADD_ONS, listPlans, getPlan };
