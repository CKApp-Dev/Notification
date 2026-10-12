'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const script = resolve(__dirname, 'deploy.sh');
const repositoryRoot = resolve(__dirname, '../..');

test('default preparation runs without gcloud, credentials or network', () => {
  const result = spawnSync('/bin/sh', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Preparation only/);
  assert.match(result.stdout, /--ignore-file=/);
});

test('GitHub worker workflows allow manual dispatch only', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/announcements.yml'), 'utf8');
  const template = readFileSync(resolve(repositoryRoot, 'firebase/github-actions/announcements.yml'), 'utf8');
  assert.equal(workflow, template);
  const triggers = workflow.split('\non:\n')[1]?.split('\npermissions:')[0];
  assert.equal(triggers?.trim(), 'workflow_dispatch:');
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' &&/);
});

for (const serviceUrl of ['https://ck-announcements-example-uc.a.run.app', 'https://unexpected.example']) {
  test(`apply prepares a request-only service and guards frontend URL ${serviceUrl}`, () => {
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
printf '%s\\n' "$*" >> "$TASK_TEST_CALLS"
printf '%s\\n' "$CLOUDSDK_CONFIG" > "$TASK_TEST_CONFIG"
case "$1 $2" in
  'projects describe') printf '253500838094\\n' ;;
  'billing projects') printf 'True\\n' ;;
  'artifacts docker') printf 'sha256:test-image-digest\\n' ;;
  'run services') printf '%s\\n' "$TASK_TEST_SERVICE_URL" ;;
esac
`, { mode: 0o700 });
      const result = spawnSync('/bin/sh', [script, '--apply'], {
        encoding: 'utf8', input: secret,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TASK_TEST_CALLS: callsFile, TASK_TEST_CONFIG: configFile, TASK_TEST_SERVICE_URL: serviceUrl },
      });
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n');
      assert.ok(calls.every(call => !/scheduler|roles\/run\.invoker|allUsers/.test(call)));
      assert.ok(calls.every(call => !/^(run jobs (execute|create)|functions call)\b/.test(call)));
      assert.equal(calls.filter(call => call.startsWith('run services ')).length, 1);
      const deployment = calls.find(call => call.startsWith('run deploy '));
      for (const option of ['--min-instances=0', '--max-instances=1', '--cpu-throttling', '--no-invoker-iam-check']) {
        assert.ok(deployment?.split(' ').includes(option));
      }
      assert.ok(!deployment?.includes('--allow-unauthenticated'));
      assert.ok(!deployment?.includes('--invoker-iam-check'));
      const validUrl = serviceUrl.endsWith('.run.app');
      assert.equal(result.status, validUrl ? 0 : 1);
      if (validUrl) {
        assert.match(result.stdout, /VITE_ANNOUNCEMENTS_WORKER_URL=https:\/\/ck-announcements-example-uc\.a\.run\.app\/run\n/);
        assert.match(result.stdout, /Deployment does not invoke the worker/);
      } else {
        assert.match(result.stderr, /Unexpected service URL/);
        assert.ok(!result.stdout.includes('VITE_ANNOUNCEMENTS_WORKER_URL='));
      }
      assert.equal(existsSync(readFileSync(configFile, 'utf8').trim()), false);
      assert.ok(!`${result.stdout}${result.stderr}${calls.join('\n')}`.includes(secret));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

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
