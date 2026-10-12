import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualPublisher, publicationEndpoint } from './publication.ts';

const endpoint = 'https://ck-announcements-example.us-central1.run.app/run';
const user = { getIdToken: async () => 'test-id-token' };

test('creating the publisher does no work; only an explicit call sends an authenticated request', async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const publish = createManualPublisher(endpoint, (async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('', { status: 200 });
  }) as typeof fetch);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  await publish(user);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].options?.method, 'POST');
  assert.deepEqual(calls[0].options?.headers, { Authorization: 'Bearer test-id-token' });
  assert.equal(calls[0].options?.redirect, 'error');
  assert.equal(calls[0].options?.credentials, 'omit');
});

test('duplicate clicks share one in-flight request and a later click starts another pass', async () => {
  let finish!: () => void;
  let calls = 0;
  const publish = createManualPublisher(endpoint, (async () => {
    calls++;
    await new Promise<void>(resolve => { finish = resolve; });
    return new Response('', { status: 200 });
  }) as typeof fetch);
  const first = publish(user);
  const duplicate = publish(user);
  assert.equal(first, duplicate);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  await first;
  const next = publish(user);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  finish();
  await next;
});

test('errors do not schedule retries and a deliberate retry is possible', async () => {
  let calls = 0;
  const publish = createManualPublisher(endpoint, (async () => {
    calls++;
    return new Response('secret provider details', { status: calls === 1 ? 403 : 200 });
  }) as typeof fetch);
  await assert.rejects(publish(user), { code: 'permission-denied' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  await publish(user);
  assert.equal(calls, 2);
});

test('invalid or unconfigured destinations cannot receive the user token', async () => {
  for (const value of ['', 'http://example.run.app/run', 'https://example.com/run',
    'https://example.run.app.evil.test/run', 'https://user:password@example.run.app/run',
    'https://example.run.app:4433/run', 'https://example.run.app/run?token=1', 'https://example.run.app/run#fragment']) {
    assert.equal(publicationEndpoint(value), null, value);
    let called = false;
    const publish = createManualPublisher(value, (async () => { called = true; return new Response(); }) as typeof fetch);
    await assert.rejects(publish({ getIdToken: async () => { called = true; return 'token'; } }), { code: 'failed-precondition' });
    assert.equal(called, false);
  }
});
