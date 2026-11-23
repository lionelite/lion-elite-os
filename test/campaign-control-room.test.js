const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryWorkspaceStore } = require('../lib/platform/workspace-store');

test('campaign control room counts pipeline stages', async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createWorkspace({ name: 'Acme' });
  const campaign = await store.createCampaign(workspace.workspaceId, { name: 'Ops Leaders', intentThreshold: 4 });
  await store.addProspect(workspace.workspaceId, campaign.campaignId, { contactName: 'A', fitScore: 80, intentHeat: 4, status: 'queued' });
  await store.addProspect(workspace.workspaceId, campaign.campaignId, { contactName: 'B', fitScore: 40, intentHeat: 2, status: 'discovered' });
  const room = await store.getCampaignControlRoom(workspace.workspaceId, campaign.campaignId);
  assert.deepEqual(room.counts, { found: 2, fit: 1, warm: 1, queued: 1, replied: 0, meetings: 0 });
});

test('recording a reply stops outbound state and opens inbox thread', async () => {
  const store = new MemoryWorkspaceStore();
  const workspace = await store.createWorkspace({ name: 'Acme' });
  const campaign = await store.createCampaign(workspace.workspaceId, { name: 'Ops Leaders' });
  const prospect = await store.addProspect(workspace.workspaceId, campaign.campaignId, { contactName: 'A', status: 'queued', intentHeat: 5 });
  const result = await store.recordReply(workspace.workspaceId, prospect.prospectId, 'interested');
  assert.equal(result.prospect.status, 'replied');
  assert.equal(result.prospect.nextAction, 'book_meeting');
  assert.equal(result.thread.status, 'open');
  assert.equal(result.thread.classification, 'interested');
});