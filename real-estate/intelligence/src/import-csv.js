const fs = require('node:fs');
const path = require('node:path');

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(String(value).replace(/[$,%]/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function toBoolean(value) {
  return ['true', 'yes', 'y', '1'].includes(String(value || '').trim().toLowerCase());
}

function normalizeRow(row, sourceName) {
  return {
    externalId: row.external_id || row.id || null,
    sourceName,
    sourceUrl: row.source_url || null,
    address: row.address,
    city: row.city || 'Miami',
    state: row.state || 'FL',
    postalCode: row.postal_code || row.zip || null,
    county: row.county || 'Miami-Dade',
    propertyType: row.property_type || 'multifamily',
    advertisedUnitCount: toNumber(row.unit_count || row.units),
    askingPrice: toNumber(row.asking_price || row.price),
    estimatedMarketValue: toNumber(row.estimated_market_value || row.market_value),
    estimatedAfterRepairValue: toNumber(row.arv),
    estimatedRepairs: toNumber(row.estimated_repairs || row.repairs) || 0,
    monthlyGrossRent: toNumber(row.monthly_gross_rent || row.monthly_rent) || 0,
    annualOperatingExpenses: toNumber(row.annual_operating_expenses || row.expenses) || 0,
    annualDebtService: toNumber(row.annual_debt_service || row.debt_service) || 0,
    ownerName: row.owner_name || null,
    ownerMailingAddress: row.owner_mailing_address || null,
    yearsOwned: toNumber(row.years_owned),
    estimatedEquityPct: toNumber(row.estimated_equity_pct || row.equity_pct),
    foreclosureSignal: toBoolean(row.pre_foreclosure || row.foreclosure_signal),
    taxDelinquentSignal: toBoolean(row.tax_delinquent || row.tax_delinquent_signal),
    codeViolationSignal: toBoolean(row.code_violation || row.code_violation_signal),
    probateSignal: toBoolean(row.probate || row.probate_signal),
    vacantSignal: toBoolean(row.vacant || row.vacant_signal),
    absenteeOwnerSignal: toBoolean(row.absentee_owner || row.absentee_owner_signal),
    rawPayload: row,
  };
}

function importCsv(filePath, sourceName = 'csv-import') {
  const text = fs.readFileSync(path.resolve(filePath), 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
    if (!row.address) throw new Error('Every imported property requires an address.');
    return normalizeRow(row, sourceName);
  });
}

if (require.main === module) {
  const [, , filePath, sourceName] = process.argv;
  if (!filePath) {
    console.error('Usage: node import-csv.js <file.csv> [source-name]');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(importCsv(filePath, sourceName), null, 2)}\n`);
}

module.exports = { importCsv, normalizeRow, parseCsvLine };
