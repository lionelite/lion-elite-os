'use strict';

// Regression guard for a bug that ran unguarded in production.
//
// The three care-plan writers use `INSERT INTO ... SELECT client_id, $2, ...
// FROM coaching_clients`. In that form Postgres has no target column to infer a
// parameter's type from, so a JS array bound to a jsonb column arrives as a
// Postgres array literal and fails with "invalid input syntax for type json".
// Every nutrition plan, supplement plan and peptide protocol write threw.
//
// Nothing caught it: CI provisions Redis and not Postgres, and the portal tests
// exercise MemoryCoachingStore. Same shape as the audit_events mismatch. Since a
// live database still is not available here, this asserts the fix in source
// text, matching test/postgres-prospect-store-schema.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'coaching', 'store.js'), 'utf8');

/** Grab the argument array of one INSERT ... SELECT statement by table name. */
function statementFor(table) {
  const start = SOURCE.indexOf(`INSERT INTO ${table}`);
  assert.notEqual(start, -1, `${table} insert not found`);
  return SOURCE.slice(start, start + 1200);
}

const JSONB_CARE_PLANS = [
  { table: 'coaching_nutrition_plans', field: 'meals' },
  { table: 'coaching_supplement_plans', field: 'items' },
  { table: 'coaching_peptide_protocols', field: 'items' }
];

for (const { table, field } of JSONB_CARE_PLANS) {
  test(`${table} casts its jsonb parameter explicitly`, () => {
    const statement = statementFor(table);
    assert.ok(
      statement.includes('::jsonb'),
      `${table} binds a jsonb column through INSERT ... SELECT and must cast it, or every write throws`
    );
    assert.ok(
      statement.includes(`JSON.stringify(input.${field}`),
      `${table} must send ${field} as JSON text, not a JS array`
    );
  });
}

test('columns that are not jsonb are not cast to jsonb', () => {
  // A stray ::jsonb on a text column fails just as loudly in the other
  // direction, and is easy to introduce while fixing the above.
  const messages = statementFor('coaching_messages');
  assert.ok(
    !messages.includes('::jsonb'),
    'coaching_messages has no jsonb column; sender_name and body are text'
  );
});
