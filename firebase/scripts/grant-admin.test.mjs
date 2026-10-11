import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsForRole, grantRole, isRootedOwner, parseOptions } from './grant-admin.mjs';

const user = (email, overrides = {}) => ({ uid: email.split('@')[0], email, emailVerified: true, disabled: false,
  providerData: [{ providerId: 'google.com', email }], customClaims: {}, ...overrides });

function fixture(target, pages = [], initialRows = {}) {
  const events = [];
  const rows = new Map(Object.entries(initialRows));
  const clients = {
    auth: {
      getUserByEmail: async () => target,
      listUsers: async (_limit, token) => {
        events.push(['list', token]);
        return pages[Number(token ?? 0)] ?? { users: [] };
      },
      setCustomUserClaims: async (uid, claims) => events.push(['claims', uid, claims]),
    },
    db: {
      collection: () => ({ doc: (email) => email }),
      runTransaction: async (callback) => callback({
        get: async (email) => ({ data: () => rows.get(email) }),
        set: (email, row) => {
          rows.set(email, row);
          events.push(['membership', email, row.role]);
        },
      }),
    },
    serverTimestamp: () => 'server-time',
  };
  return { clients, rows, events };
}

test('role arguments default to admin and preserve account-manager as the owner alias', () => {
  const base = ['--project', 'demo-ck-announcements', '--email', 'Teacher@Example.com'];
  assert.deepEqual(parseOptions(base), { projectId: 'demo-ck-announcements', email: 'teacher@example.com', role: 'admin' });
  assert.equal(parseOptions([...base, '--role', 'super_admin']).role, 'super_admin');
  assert.equal(parseOptions([...base, '--account-manager']).role, 'owner');
  assert.equal(parseOptions([...base, '--role', 'owner', '--account-manager']).role, 'owner');
  for (const args of [
    [...base, '--role', 'other'], [...base, '--role', 'admin', '--account-manager'],
    [...base, '--role'], [...base, '--unknown'], [...base, '--project', 'other'],
    ['--project', 'demo', '--email', '.teacher@example.com'],
  ]) assert.throws(() => parseOptions(args), /Usage/);
});

test('only owner claims root access; nonowner grants remove all legacy privileges and preserve unrelated claims', () => {
  assert.equal(isRootedOwner({ role: 'owner' }), true);
  assert.equal(isRootedOwner({ admin: true, accountManager: true }), true);
  for (const claims of [{ role: 'super_admin' }, { admin: true }, { admin: 'true', accountManager: true }]) {
    assert.equal(isRootedOwner(claims), false);
  }
  const original = { admin: true, accountManager: true, role: 'owner', feature: 'keep' };
  assert.deepEqual(claimsForRole(original, 'admin'), { feature: 'keep' });
  assert.deepEqual(claimsForRole(original, 'super_admin'), { feature: 'keep' });
  assert.deepEqual(claimsForRole({ feature: 'keep' }, 'owner'), original);
  assert.equal(original.role, 'owner');
  assert.throws(() => claimsForRole({}, 'unknown'));
});

test('grant registers every legacy and current owner before activating a super admin membership', async () => {
  const target = user('manager@example.com', { customClaims: { admin: true, role: 'super_admin', feature: 'keep' } });
  const legacyOwner = user('owner@example.com', { customClaims: { admin: true, accountManager: true } });
  const currentOwner = user('owner2@example.com', { customClaims: { role: 'owner' } });
  const setup = fixture(target, [
    { users: [legacyOwner], pageToken: '1' }, { users: [currentOwner, target] },
  ], { 'manager@example.com': { createdAt: 'original-time', createdBy: 'inviter', displayName: 'Manager', enabled: false } });
  await grantRole(setup.clients, { email: target.email, role: 'super_admin' });
  assert.deepEqual(setup.events.filter(([kind]) => kind === 'membership'), [
    ['membership', 'owner@example.com', 'owner'], ['membership', 'owner2@example.com', 'owner'],
    ['membership', target.email, 'super_admin'],
  ]);
  assert.deepEqual(setup.events.at(-1), ['claims', 'manager', { feature: 'keep' }]);
  assert.deepEqual(setup.rows.get(target.email), {
    email: target.email, role: 'super_admin', enabled: true, displayName: 'Manager',
    createdAt: 'original-time', updatedAt: 'server-time', createdBy: 'inviter',
  });
});

test('owner bootstrap writes a protective registry before granting rooted claims', async () => {
  const target = user('owner@example.com');
  const setup = fixture(target);
  await grantRole(setup.clients, { email: target.email, role: 'owner' });
  assert.deepEqual(setup.events.slice(-2), [
    ['membership', target.email, 'owner'], ['claims', target.uid, { role: 'owner', admin: true, accountManager: true }],
  ]);
});

test('rooted and registered owners cannot be demoted through the grant helper', async () => {
  for (const customClaims of [{ role: 'owner' }, { admin: true, accountManager: true }]) {
    const target = user('owner@example.com', { customClaims });
    const setup = fixture(target);
    await assert.rejects(grantRole(setup.clients, { email: target.email, role: 'admin' }), /cannot be demoted/);
    assert.deepEqual(setup.events, []);
  }
  const target = user('owner@example.com');
  const setup = fixture(target, [], { [target.email]: { role: 'owner' } });
  await assert.rejects(grantRole(setup.clients, { email: target.email, role: 'super_admin' }), /cannot be demoted/);
  assert.equal(setup.rows.get(target.email).role, 'owner');
  assert.equal(setup.events.some(([kind]) => kind === 'claims'), false);
});

test('unverified, disabled and non-Google accounts fail before membership or claim writes', async () => {
  for (const overrides of [{ disabled: true }, { emailVerified: false }, { providerData: [{ providerId: 'password' }] },
    { providerData: [{ providerId: 'google.com', email: 'other@example.com' }] }]) {
    const target = user('teacher@example.com', overrides);
    const setup = fixture(target);
    await assert.rejects(grantRole(setup.clients, { email: target.email, role: 'admin' }), /verified, enabled Google/);
    assert.deepEqual(setup.events, []);
  }
});

test('failed owner registration prevents new manager access', async () => {
  const target = user('manager@example.com');
  const setup = fixture(target, [{ users: [user('invalid-email', { customClaims: { role: 'owner' } })] }]);
  await assert.rejects(grantRole(setup.clients, { email: target.email, role: 'super_admin' }), /unsupported email/);
  assert.equal(setup.rows.has(target.email), false);
  assert.equal(setup.events.some(([kind]) => kind === 'claims'), false);
});
