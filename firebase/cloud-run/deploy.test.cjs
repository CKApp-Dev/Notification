'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const script = resolve(__dirname, 'deploy.sh');

test('default preparation runs without gcloud, credentials or network', () => {
  const result = spawnSync('/bin/sh', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Preparation only/);
  assert.match(result.stdout, /--ignore-file=/);
});

for (const mode of ['billing-disabled', 'wrong-project']) {
  test(`apply refuses ${mode}, accepts stdin EOF and removes temporary CLI state`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'ck-announcements-deploy-test-'));
    try {
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      const callsFile = join(directory, 'calls');
      const configFile = join(directory, 'config-path');
      const secret = 'test-operator-token-do-not-log';
      writeFileSync(join(bin, 'gcloud'), `#!/bin/sh
set -eu
test "$CLOUDSDK_AUTH_ACCESS_TOKEN" = 'test-operator-token-do-not-log'
test "$CLOUDSDK_CORE_DISABLE_FILE_LOGGING" = '1'
test -d "$CLOUDSDK_CONFIG"
printf '%s\\n' "$*" >> "$TASK_TEST_CALLS"
printf '%s\\n' "$CLOUDSDK_CONFIG" > "$TASK_TEST_CONFIG"
case "$1 $2" in
  'projects describe')
    if [ "$TASK_TEST_MODE" = 'wrong-project' ]; then printf '999999999\\n'; else printf '253500838094\\n'; fi ;;
  'billing projects') printf 'False\\n' ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
      const result = spawnSync('/bin/sh', [script, '--apply'], {
        encoding: 'utf8', input: secret,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASK_TEST_CALLS: callsFile, TASK_TEST_CONFIG: configFile, TASK_TEST_MODE: mode },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, mode === 'billing-disabled' ? /Billing is disabled/ : /Project identity mismatch/);
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n');
      assert.equal(calls.length, mode === 'billing-disabled' ? 2 : 1);
      assert.ok(calls.every(call => /^(projects describe|billing projects describe) /.test(call)));
      assert.equal(existsSync(readFileSync(configFile, 'utf8').trim()), false);
      assert.ok(!`${result.stdout}${result.stderr}${calls.join('\n')}`.includes(secret));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
