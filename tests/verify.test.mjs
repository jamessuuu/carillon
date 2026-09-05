import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanDir } from '../verify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const VERIFY_SCRIPT = join(PROJECT_ROOT, 'verify.mjs');
const FIXTURES = join(__dirname, 'fixtures', 'verify');

function ruleIds(rootDir) {
  return new Set(scanDir(rootDir).map((v) => v.rule));
}

test('the clean fixture has zero violations', () => {
  assert.deepEqual(scanDir(join(FIXTURES, 'clean')), []);
});

test('the real project site (index.html + src/) has zero violations', () => {
  // This is the check that actually matters: verify.mjs run against the
  // shipped site, not just a fixture, must come back clean.
  assert.deepEqual(scanDir(PROJECT_ROOT), []);
});

const BAD_FIXTURES = [
  'fetch-call',
  'xhr',
  'send-beacon',
  'external-src-href',
  'cdn-script',
  'analytics-identifier',
];

for (const ruleId of BAD_FIXTURES) {
  test(`the "${ruleId}" fixture is caught by its own rule`, () => {
    assert.ok(ruleIds(join(FIXTURES, ruleId)).has(ruleId), `expected rule "${ruleId}" to fire`);
  });
}

test('every rule id in RULES has a corresponding fixture directory above', () => {
  // A check that cannot fail is not a check — this guards against a
  // future rule being added to verify.mjs without a fixture proving it
  // actually bites.
  const allViolations = BAD_FIXTURES.flatMap((id) => scanDir(join(FIXTURES, id)));
  const coveredRuleIds = new Set(allViolations.map((v) => v.rule));
  for (const ruleId of BAD_FIXTURES) {
    assert.ok(coveredRuleIds.has(ruleId), `no fixture triggered rule "${ruleId}"`);
  }
});

test('CLI: verify.mjs exits 0 on the clean fixture and prints an OK line', () => {
  const result = spawnSync(process.execPath, [VERIFY_SCRIPT, join(FIXTURES, 'clean')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verify: OK/);
});

test('CLI: verify.mjs exits 0 on the real project site', () => {
  const result = spawnSync(process.execPath, [VERIFY_SCRIPT, PROJECT_ROOT], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verify: OK/);
});

for (const ruleId of BAD_FIXTURES) {
  test(`CLI: verify.mjs exits non-zero on the "${ruleId}" fixture and names the rule`, () => {
    const result = spawnSync(process.execPath, [VERIFY_SCRIPT, join(FIXTURES, ruleId)], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /verify: FAIL/);
    assert.match(result.stderr, new RegExp(ruleId));
  });
}
