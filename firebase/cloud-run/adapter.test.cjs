'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, DEFAULT_ALLOWED_ORIGIN } = require('./adapter.cjs');
const { createAuthorizer } = require('./auth.cjs');

function response() {
  return {
    status: undefined, headers: undefined, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

function request(overrides = {}) {
  return {
    method: 'POST', url: '/run',
    ...overrides,
    headers: { origin: DEFAULT_ALLOWED_ORIGIN, authorization: 'Bearer firebase-id-token', ...overrides.headers },
  };
}

test('authorized POST /run invokes once and waits for completion before acknowledging', async () => {
  let finish, started;
  const work = new Promise(resolve => { finish = resolve; });
  const start = new Promise(resolve => { started = resolve; });
  let called = 0;
  const handler = createHandler(() => { called++; started(); return work; }, { authorize: async () => 'authorized' });
  const reply = response();
  const running = handler(request(), reply);
  await start;
  assert.equal(called, 1);
  assert.equal(reply.status, undefined);
  finish();
  await running;
  assert.equal(reply.status, 200);
  assert.equal(reply.body, 'Worker pass completed\n');
  assert.equal(reply.headers['Access-Control-Allow-Origin'], DEFAULT_ALLOWED_ORIGIN);
  assert.equal(reply.headers['Cache-Control'], 'no-store');
});

test('provider failures return retryable status without logging error details', async () => {
  const secret = 'do-not-print-bearer-or-request';
  const logs = [];
  const handler = createHandler(async () => { throw new Error(secret); }, {
    authorize: async () => 'authorized',
    logger: { error: (...args) => logs.push(args) },
  });
  const reply = response();
  await handler(request(), reply);
  assert.equal(reply.status, 500);
  assert.deepEqual(logs, [['Announcement worker pass failed.']]);
  assert.ok(!JSON.stringify({ logs, reply }).includes(secret));
});

test('CORS preflight permits only the configured website and never authenticates or runs work', async () => {
  let called = 0, authenticated = 0;
  const handler = createHandler(async () => { called++; }, {
    authorize: async () => { authenticated++; return 'authorized'; },
  });
  const reply = response();
  await handler(request({ method: 'OPTIONS', headers: {
    authorization: undefined,
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization, content-type',
  } }), reply);
  assert.equal(reply.status, 204);
  assert.equal(reply.headers['Access-Control-Allow-Origin'], DEFAULT_ALLOWED_ORIGIN);
  assert.equal(reply.headers['Access-Control-Allow-Methods'], 'POST');
  assert.equal(reply.headers['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
  assert.equal(called, 0);
  assert.equal(authenticated, 0);
});

test('missing and other origins cannot authenticate or start work', async () => {
  let called = 0, authenticated = 0;
  const handler = createHandler(async () => { called++; }, {
    authorize: async () => { authenticated++; return 'authorized'; },
  });
  for (const origin of [undefined, 'null', 'http://notification.cksc.tw', 'https://notification.cksc.tw.evil.example']) {
    for (const method of ['POST', 'OPTIONS']) {
      const reply = response();
      await handler(request({ method, headers: { origin, 'access-control-request-method': 'POST' } }), reply);
      assert.equal(reply.status, 403);
      assert.equal(reply.headers['Access-Control-Allow-Origin'], undefined);
    }
  }
  assert.equal(called, 0);
  assert.equal(authenticated, 0);
});

test('unsupported preflight method and headers never start work', async () => {
  let called = 0, authenticated = 0;
  const handler = createHandler(async () => { called++; }, {
    authorize: async () => { authenticated++; return 'authorized'; },
  });
  for (const headers of [
    { 'access-control-request-method': 'GET' },
    {},
    { 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-Admin' },
  ]) {
    const reply = response();
    await handler(request({ method: 'OPTIONS', headers }), reply);
    assert.ok([403, 405].includes(reply.status));
  }
  assert.equal(called, 0);
  assert.equal(authenticated, 0);
});

test('unauthenticated, forbidden and unexpected authorization results cannot start work', async () => {
  let called = 0;
  for (const [authorization, status] of [['unauthenticated', 401], ['forbidden', 403], [undefined, 403], [true, 403]]) {
    const handler = createHandler(async () => { called++; }, { authorize: async () => authorization });
    const reply = response();
    await handler(request(), reply);
    assert.equal(reply.status, status);
    assert.equal(reply.headers['Access-Control-Allow-Origin'], DEFAULT_ALLOWED_ORIGIN);
  }
  assert.equal(called, 0);
});

test('invalid or expired token is rejected without logging token or provider details', async () => {
  const secret = 'secret-token-or-provider-error';
  let called = 0, reads = 0;
  const logs = [];
  const authorize = createAuthorizer({
    verifyIdToken: async () => { throw new Error(secret); },
    readAdminAccount: async () => { reads++; },
  });
  const handler = createHandler(async () => { called++; }, { authorize, logger: { error: (...args) => logs.push(args) } });
  const reply = response();
  await handler(request({ headers: { authorization: `Bearer ${secret}` } }), reply);
  assert.equal(reply.status, 401);
  assert.equal(called, 0);
  assert.equal(reads, 0);
  assert.deepEqual(logs, []);
  assert.ok(!JSON.stringify(reply).includes(secret));
});

test('account lookup failure fails closed without exposing provider details', async () => {
  const secret = 'secret-firestore-request';
  let called = 0;
  const logs = [];
  const authorize = createAuthorizer({
    verifyIdToken: async () => ({ email: 'admin@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } }),
    readAdminAccount: async () => { throw new Error(secret); },
  });
  const handler = createHandler(async () => { called++; }, { authorize, logger: { error: (...args) => logs.push(args) } });
  const reply = response();
  await handler(request(), reply);
  assert.equal(reply.status, 503);
  assert.equal(called, 0);
  assert.deepEqual(logs, [['Announcement authorization failed.']]);
  assert.ok(!JSON.stringify({ logs, reply }).includes(secret));
});

test('other methods and unknown paths cannot authenticate or start work', async () => {
  let called = 0, authenticated = 0;
  const handler = createHandler(async () => { called++; }, {
    authorize: async () => { authenticated++; return 'authorized'; },
  });
  for (const [overrides, status] of [[{ method: 'GET' }, 405], [{ url: '/unknown' }, 404]]) {
    const reply = response();
    await handler(request(overrides), reply);
    assert.equal(reply.status, status);
  }
  assert.equal(called, 0);
  assert.equal(authenticated, 0);
});

test('handler requires explicit authorization and rejects broad or insecure origin configuration', () => {
  assert.throws(() => createHandler(async () => {}), /authorization/);
  for (const allowedOrigin of ['*', 'http://notification.cksc.tw', 'https://notification.cksc.tw/', 'https://user:pass@notification.cksc.tw']) {
    assert.throws(() => createHandler(async () => {}, { authorize: async () => 'authorized', allowedOrigin }));
  }
});
