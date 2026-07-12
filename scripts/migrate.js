'use strict';

const { migrate, healthcheck, close } = require('../lib/database');

(async () => {
  try {
    await migrate();
    const health = await healthcheck();
    console.log('PostgreSQL migration complete.', health);
  } catch (error) {
    console.error('PostgreSQL migration failed.', error);
    process.exitCode = 1;
  } finally {
    await close();
  }
})();
