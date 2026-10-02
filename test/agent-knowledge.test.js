const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const knowledge = require('../lib/agents/knowledge');
const roles = require('../lib/agents/roles');

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kb-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  }
  return dir;
}

test('every role builds a grounded knowledge base from the real repo', () => {
  for (const r of roles.ROLES) {
    const k = knowledge.buildKnowledge(r.id);
    assert.equal(k.grounded, true, `${r.id} indexed nothing`);
    assert.ok(k.factCount > 0, `${r.id} has no facts`);
    assert.ok(k.sources.length > 0, `${r.id} has no sources`);
  }
});

test('no role points at a knowledge domain that is missing', () => {
  for (const r of roles.ROLES) {
    assert.deepEqual(knowledge.buildKnowledge(r.id).missingDomains, [], `${r.id} has broken domains`);
  }
});

test('every fact carries a file and line so a human can check the agent', () => {
  const k = knowledge.buildKnowledge('sales');
  for (const fact of k.facts) {
    assert.ok(fact.file && fact.file.length > 0, 'fact without a file');
    assert.ok(Number.isInteger(fact.line) && fact.line > 0, 'fact without a line');
    assert.ok(['structure', 'directive', 'stated-number', 'dataset'].includes(fact.kind), `unknown kind ${fact.kind}`);
  }
});

test('citations point at real lines in real files', () => {
  const root = path.join(__dirname, '..');
  const k = knowledge.buildKnowledge('research-compliance');
  // Spot-check a sample rather than every fact, to keep the suite fast.
  for (const fact of k.facts.slice(0, 15)) {
    if (fact.kind === 'dataset') continue;
    const lines = fs.readFileSync(path.join(root, fact.file), 'utf8').split('\n');
    assert.ok(fact.line <= lines.length, `${fact.file}:${fact.line} is past end of file`);
    assert.ok(lines[fact.line - 1].includes(fact.text.slice(0, 30)),
      `${fact.file}:${fact.line} does not contain the cited text`);
  }
});

test('the build is deterministic — same repo, same knowledge', () => {
  const a = knowledge.buildKnowledge('marketing');
  const b = knowledge.buildKnowledge('marketing');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a source quoting dosing language is marked internal-only, not indexed as publishable', () => {
  const dir = tmpRepo({
    'docs/rules.md': '# Rules\n\n- Never write: take 5mg twice daily for weight loss\n- Keep it research-use-only\n',
  });
  const result = knowledge.extractFacts(path.join(dir, 'docs/rules.md'), { root: dir });
  assert.equal(result.internalOnly, true, 'a file quoting dosing language must be flagged');
  assert.ok(result.complianceBlockers.length > 0);
  // Still usable for reasoning — we adopt the rule, never the wording.
  assert.ok(result.facts.length > 0);
});

test('clean research-safe copy is not flagged', () => {
  const dir = tmpRepo({ 'docs/clean.md': '# Process\n\n- Log every run with a timestamp\n- Escalate failures to the owner\n' });
  assert.equal(knowledge.extractFacts(path.join(dir, 'docs/clean.md'), { root: dir }).internalOnly, false);
});

test('a missing domain is reported rather than silently skipped', () => {
  const dir = tmpRepo({ 'docs/real.md': '# Real\n\n- A directive here\n' });
  const { files, missing } = knowledge.resolveSources(['docs/real.md', 'docs/ghost.md', 'nowhere'], { root: dir });
  assert.equal(files.length, 1);
  assert.deepEqual(missing, ['docs/ghost.md', 'nowhere']);
});

test('an empty directory is reported as missing, not as a silent success', () => {
  const dir = tmpRepo({ 'docs/real.md': '# x\n' });
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  const { missing } = knowledge.resolveSources(['empty'], { root: dir });
  assert.ok(missing.some((m) => m.includes('no indexable files')));
});

test('classification distinguishes structure, directives and stated numbers', () => {
  assert.equal(knowledge.classify('## A heading here'), 'structure');
  assert.equal(knowledge.classify('- Do the thing properly'), 'directive');
  assert.equal(knowledge.classify('Target is $3,500 per day'), 'stated-number');
  assert.equal(knowledge.classify('Conversion sits at 12.5%'), 'stated-number');
  assert.equal(knowledge.classify(''), null);
  assert.equal(knowledge.classify('   '), null);
  assert.equal(knowledge.classify('just some prose without structure'), null);
});

test('JSON sources are recorded as datasets rather than mined for prose', () => {
  const dir = tmpRepo({ 'data/x.json': JSON.stringify({ alpha: 1, beta: 2 }) });
  const result = knowledge.extractFacts(path.join(dir, 'data/x.json'), { root: dir });
  assert.equal(result.facts[0].kind, 'dataset');
  assert.match(result.facts[0].text, /alpha, beta/);
});

test('unparseable JSON is skipped with a reason, not crashed on', () => {
  const dir = tmpRepo({ 'data/bad.json': '{ not json' });
  const result = knowledge.extractFacts(path.join(dir, 'data/bad.json'), { root: dir });
  assert.match(result.skipped, /unparseable JSON/);
  assert.deepEqual(result.facts, []);
});

test('one huge file cannot crowd out a role\'s other sources', () => {
  const dir = tmpRepo({ 'docs/big.md': Array.from({ length: 500 }, (_, i) => `- directive number ${i} with enough text`).join('\n') });
  const result = knowledge.extractFacts(path.join(dir, 'docs/big.md'), { root: dir });
  assert.equal(result.facts.length, knowledge.MAX_FACTS_PER_SOURCE);
});

test('recall returns cited hits ranked by relevance', () => {
  const k = knowledge.buildKnowledge('sales');
  const hits = knowledge.recall(k, 'build value before price');
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(h.file && h.line);
    assert.ok(h.score > 0);
  }
  for (let i = 1; i < hits.length; i += 1) assert.ok(hits[i - 1].score >= hits[i].score, 'hits must be ranked');
});

test('recall on an unknown topic returns nothing rather than a guess', () => {
  const k = knowledge.buildKnowledge('sales');
  assert.deepEqual(knowledge.recall(k, 'quantum chromodynamics zzzz'), []);
  assert.deepEqual(knowledge.recall(k, ''), []);
  assert.deepEqual(knowledge.recall(k, 'a'), [], 'single letters are not search terms');
});

test('an unknown role cannot have a knowledge base built', () => {
  assert.throws(() => knowledge.buildKnowledge('nope'), /Unknown role/);
});

test('the coverage report names ungrounded roles and broken domains', () => {
  const report = knowledge.coverageReport();
  assert.equal(report.roles.length, roles.ROLES.length);
  assert.deepEqual(report.ungrounded, []);
  assert.deepEqual(report.brokenDomains, []);
  assert.ok(report.totalFacts > 100);
});

test('buildAll covers every role in the registry', () => {
  const all = knowledge.buildAll();
  assert.deepEqual(all.map((k) => k.roleId).sort(), roles.roleIds().sort());
});
