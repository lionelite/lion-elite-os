const express = require('express');
const { listPlans, ADD_ONS } = require('../lib/platform/plans');

function createPlatformRouter() {
  const router = express.Router();

  router.get('/plans', (_req, res) => {
    res.json({
      plans: listPlans(),
      addOns: {
        additionalChannelConnectionMonthly: ADD_ONS.channelConnectionMonthlyCents / 100,
        additionalClientWorkspaceMonthly: ADD_ONS.clientWorkspaceMonthlyCents / 100,
        additionalSeatMonthly: ADD_ONS.seatMonthlyCents / 100
      }
    });
  });

  return router;
}

module.exports = { createPlatformRouter };
