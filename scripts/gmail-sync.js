'use strict';

const gmail = require('../lib/gmail-integration');
const { close } = require('../lib/database');

(async () => {
  const connection = await gmail.activeConnection();
  if (!connection) throw new Error('Gmail is not connected.');
  const result = await gmail.syncConnection(connection, gmail.getConfig());
  console.log(JSON.stringify({ event: 'gmail.sync.complete', ...result }));
})().catch(error => {
  console.error(JSON.stringify({ event: 'gmail.sync.failed', code: error.code, message: error.message }));
  process.exitCode = 1;
}).finally(close);
