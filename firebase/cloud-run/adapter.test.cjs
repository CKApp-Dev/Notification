'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('./adapter.cjs');

function response() {
  return {
    status: undefined, headers: undefined, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

test('POST /run waits for successful completion before acknowledging', async () => {
  let finish;
  const work = new Promise(resolve => { finish = resolve; });
  let called = 0;
  const handler = createHandler(() => { called++; return work; });
  const reply = response();
  const running = handler({ method: 'POST', url: '/run' }, reply);
  assert.equal(called, 1);
  assert.equal(reply.status, undefined);
  finish();
  await running;
  assert.equal(reply.status, 200);
  assert.equal(reply.body, 'Worker pass completed\n');
});

test('provider failures return retryable status without logging error details', async () => {
  const secret = 'do-not-print-bearer-or-request';
  const logs = [];
  const handler = createHandler(async () => { throw new Error(secret); }, { error: (...args) => logs.push(args) });
  const reply = response();
  await handler({ method: 'POST', url: '/run' }, reply);
  assert.equal(reply.status, 500);
  assert.deepEqual(logs, [['Announcement worker pass failed.']]);
  assert.ok(!JSON.stringify({ logs, reply }).includes(secret));
});

test('other methods cannot start work', async () => {
  let called = 0;
  const handler = createHandler(async () => { called++; });
  const reply = response();
  await handler({ method: 'GET', url: '/run' }, reply);
  assert.equal(reply.status, 405);
  assert.equal(reply.headers.Allow, 'POST');
  assert.equal(called, 0);
});

test('unknown paths cannot start work', async () => {
  let called = 0;
  const handler = createHandler(async () => { called++; });
  const reply = response();
  await handler({ method: 'POST', url: '/unknown' }, reply);
  assert.equal(reply.status, 404);
  assert.equal(called, 0);
});
