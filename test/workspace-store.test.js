const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryWorkspaceStore } = require('../lib/platform/workspace-store');

test('workspace onboarding stores business context', async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createWorkspace({ name: 'Acme AI', plan: 'solo' });
  const profile = await store.saveProfile(workspace.workspaceId, {
    websiteUrl: 'https://example.com',
    companyDescription: 'AI receptionist platform',
    offerName: 'AI Front Desk',
    offerDescription: 'Answers, qualifies and books inbound leads',
    targetGeography: 'Florida',
    icp: { industries: ['med spa'], employees: { min: 2, max: 20 } },
    exclusions: ['existing customers'],
    messagingAngles: ['missed calls cost revenue']
  });

  assert.equal(profile.workspaceId, workspace.workspaceId);
  assert.equal(profile.offerName, 'AI Front Desk');
  assert.equal(profile.onboardingStatus, 'ready');
  assert.deepEqual(profile.icp.industries, ['med spa']);
});

test('campaigns are isolated by workspace', async () => {
  const store = new MemoryWorkspaceStore();
  const a = await store.createWorkspace({ name: 'Alpha' });
  const b = await store.createWorkspace({ name: 'Beta' });

  await store.createCampaign(a.workspaceId, { name: 'Alpha outbound' });
  await store.createCampaign(b.workspaceId, { name: 'Beta outbound' });

  const alphaCampaigns = await store.listCampaigns(a.workspaceId);
  assert.equal(alphaCampaigns.length, 1);
  assert.equal(alphaCampaigns[0].name, 'Alpha outbound');
  assert.equal(alphaCampaigns[0].workspaceId, a.workspaceId);
});
