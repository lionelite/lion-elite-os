const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importCsv, parseCsvLine } = require('../src/import-csv');

test('parses quoted CSV values', () => {
  assert.deepEqual(parseCsvLine('"123 Main St, Unit 1",850000,true'), ['123 Main St, Unit 1', '850000', 'true']);
});

test('normalizes a distressed multifamily lead', () => {
  const file = path.join(os.tmpdir(), `re-leads-${Date.now()}.csv`);
  fs.writeFileSync(file, 'address,price,units,monthly_rent,pre_foreclosure,tax_delinquent,owner_name\n"123 Main St, Miami",850000,4,9800,true,false,Example Owner\n');
  const [lead] = importCsv(file, 'test-source');
  assert.equal(lead.address, '123 Main St, Miami');
  assert.equal(lead.askingPrice, 850000);
  assert.equal(lead.advertisedUnitCount, 4);
  assert.equal(lead.foreclosureSignal, true);
  assert.equal(lead.taxDelinquentSignal, false);
  assert.equal(lead.sourceName, 'test-source');
  fs.unlinkSync(file);
});

test('rejects rows without an address', () => {
  const file = path.join(os.tmpdir(), `re-leads-invalid-${Date.now()}.csv`);
  fs.writeFileSync(file, 'price,units\n850000,4\n');
  assert.throws(() => importCsv(file), /requires an address/);
  fs.unlinkSync(file);
});
