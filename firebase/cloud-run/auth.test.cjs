'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuthorizer } = require('./auth.cjs');

const validToken = { email: 'Admin@Example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } };
const validAccount = { email: 'admin@example.com', enabled: true, role: 'admin' };
const request = { headers: { authorization: 'Bearer signed-id-token' } };

test('missing and malformed Bearer tokens never call verification or account lookup', async () => {
  let verifications = 0, reads = 0;
  const authorize = createAuthorizer({
    verifyIdToken: async () => { verifications++; return validToken; },
    readAdminAccount: async () => { reads++; return validAccount; },
  });
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer ', 'Bearer a b', 'Bearer a,b', 'Bearer token\n', ['Bearer abc'], `Bearer ${'a'.repeat(8192)}`]) {
    assert.equal(await authorize({ headers: { authorization } }), 'unauthenticated');
  }
  assert.equal(verifications, 0);
  assert.equal(reads, 0);
});

test('owner claims match firestore.rules without requiring an account document', async () => {
  let reads = 0;
  for (const token of [{ role: 'owner' }, { admin: true, accountManager: true }]) {
    const authorize = createAuthorizer({
      verifyIdToken: async value => { assert.equal(value, 'signed-id-token'); return token; },
      readAdminAccount: async () => { reads++; return undefined; },
    });
    assert.equal(await authorize(request), 'authorized');
  }
  assert.equal(reads, 0);
});

test('enabled verified Google admins use lowercased email and the rules default role', async () => {
  for (const account of [validAccount, { ...validAccount, role: 'super_admin' }, { email: validAccount.email, enabled: true }]) {
    const authorize = createAuthorizer({
      verifyIdToken: async () => validToken,
      readAdminAccount: async email => { assert.equal(email, 'admin@example.com'); return account; },
    });
    assert.equal(await authorize(request), 'authorized');
  }
});

test('disabled, missing, mismatched and invalid-role accounts fail closed', async () => {
  for (const account of [
    undefined, {}, { ...validAccount, enabled: false }, { ...validAccount, enabled: 'true' },
    { ...validAccount, email: 'Admin@Example.com' }, { ...validAccount, role: 'owner' },
    { ...validAccount, role: null }, { ...validAccount, role: 'viewer' },
  ]) {
    const authorize = createAuthorizer({ verifyIdToken: async () => validToken, readAdminAccount: async () => account });
    assert.equal(await authorize(request), 'forbidden');
  }
});

test('membership is checked again on each click so disabling an admin revokes access', async () => {
  let reads = 0;
  const authorize = createAuthorizer({
    verifyIdToken: async () => validToken,
    readAdminAccount: async () => ({ ...validAccount, enabled: ++reads === 1 }),
  });
  assert.equal(await authorize(request), 'authorized');
  assert.equal(await authorize(request), 'forbidden');
  assert.equal(reads, 2);
});

test('unverified, non-Google and malformed email claims cannot use account lookup', async () => {
  let reads = 0;
  for (const token of [
    {}, { admin: true }, { accountManager: true }, { admin: 'true', accountManager: true },
    { ...validToken, email_verified: false }, { ...validToken, email_verified: 'true' },
    { ...validToken, firebase: { sign_in_provider: 'password' } },
    { ...validToken, firebase: { sign_in_provider: 'anonymous' } },
    { ...validToken, firebase: undefined },
    ...[undefined, '', 'a@localhost', 'a/b@example.com', '.admin@example.com', 'admin..a@example.com', 'admin@example.com\n', `${'a'.repeat(250)}@example.com`]
      .map(email => ({ ...validToken, email })),
  ]) {
    const authorize = createAuthorizer({
      verifyIdToken: async () => token,
      readAdminAccount: async () => { reads++; return validAccount; },
    });
    assert.equal(await authorize(request), 'forbidden');
  }
  assert.equal(reads, 0);
});

test('only the SDK verified token is used for authorization', async () => {
  let reads = 0;
  const authorize = createAuthorizer({
    verifyIdToken: async () => { throw new Error('Invalid signature or expired token'); },
    readAdminAccount: async () => { reads++; return validAccount; },
  });
  assert.equal(await authorize({ headers: { authorization: 'Bearer eyJyb2xlIjoib3duZXIifQ' } }), 'unauthenticated');
  assert.equal(reads, 0);
});

test('verification and account lookup dependencies are mandatory', () => {
  assert.throws(() => createAuthorizer({ verifyIdToken: async () => validToken }), /required/);
  assert.throws(() => createAuthorizer({ readAdminAccount: async () => validAccount }), /required/);
});
