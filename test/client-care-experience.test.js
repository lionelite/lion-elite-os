'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'public/coaching/index.html'), 'utf8');
const clientExperience = fs.readFileSync(path.join(root, 'public/coaching/client-experience.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public/coaching/client-experience.css'), 'utf8');

test('coaching shell loads the complete client experience assets', () => {
  assert.match(index, /client-experience\.css/);
  assert.match(index, /client-experience\.js/);
});

test('client home exposes all four major care modules', () => {
  for (const label of ['Training', 'Nutrition', 'Supplements', 'Peptide Protocol']) {
    assert.match(clientExperience, new RegExp(label));
  }
});

test('assistant answers from live dashboard plan data', () => {
  assert.match(clientExperience, /dashboard\.workoutPlan/);
  assert.match(clientExperience, /dashboard\.nutrition/);
  assert.match(clientExperience, /dashboard\.supplements/);
  assert.match(clientExperience, /dashboard\.protocol/);
  assert.match(clientExperience, /dashboard\.checkins/);
});

test('assistant does not invent peptide dosing or medical plan changes', () => {
  assert.match(clientExperience, /I won’t invent or change medical instructions/);
  assert.match(clientExperience, /I will not change, interpret, or generate dosing/);
  assert.match(clientExperience, /licensed clinician/);
});

test('care hub and assistant include responsive product styling', () => {
  assert.match(styles, /\.le-client-hub/);
  assert.match(styles, /\.le-assistant/);
  assert.match(styles, /@media\(max-width:720px\)/);
});
