const { test, before, beforeEach, after } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { assertFails, assertSucceeds, initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, query, where, orderBy, limit, updateDoc, deleteDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
let env;
const row = (status = 'scheduled') => ({ title: 'New announcement', body: 'News for students', url: 'https://school.example/news', status,
  publishAt: Timestamp.fromMillis(Date.now() - 10000), publishedAt: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: 'admin' });
const ownDevice = () => ({ expoPushToken: 'ExpoPushToken[test-token]', platform: 'ios', enabled: true, updatedAt: serverTimestamp() });
const adminDb = () => googleDb('admin', 'admin@example.com');
const ownerDb = () => googleDb('owner', 'owner@example.com', { role: 'owner' });
const superDb = () => googleDb('super', 'super@example.com');
const googleDb = (uid = 'invited-admin', email = 'teacher@example.com', claims = {}) => env.authenticatedContext(uid, {
  email, email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...claims,
}).firestore();
const accountRow = (email, overrides = {}) => ({ email, displayName: '', enabled: true, role: 'admin',
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: 'owner', ...overrides });
const userDb = () => env.authenticatedContext('device-user', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const publicDb = () => env.unauthenticatedContext().firestore();

before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-ck-announcements', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } }); });
beforeEach(async () => {
  await env.clearFirestore();
  await seedAccount('owner@example.com', { role: 'owner' });
  await seedAccount('super@example.com', { role: 'super_admin' });
  await seedAccount('admin@example.com');
});
after(async () => { await env.cleanup(); });
async function seed(id, status) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'announcements', id), { ...row(status), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), publishedAt: status === 'published' ? Timestamp.now() : null });
  });
}
async function seedAccount(email, overrides = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'adminAccounts', email), accountRow(email, overrides));
  });
}

test('public feed requires published query; scheduled data remains inaccessible even after its date', async () => {
  await seed('published', 'published'); await seed('scheduled', 'scheduled'); await seed('draft', 'draft');
  await assertSucceeds(getDocs(query(collection(publicDb(), 'announcements'), where('status', '==', 'published'), orderBy('publishAt', 'desc'), limit(50))));
  await assertSucceeds(getDoc(doc(publicDb(), 'announcements/published')));
  await assertSucceeds(getDocs(query(collection(userDb(), 'announcements'), where('status', '==', 'published'), orderBy('publishAt', 'desc'), limit(50))));
  await assertFails(getDoc(doc(publicDb(), 'announcements/scheduled')));
  await assertFails(getDoc(doc(publicDb(), 'announcements/draft')));
  await assertFails(getDocs(collection(publicDb(), 'announcements')));
  await assertSucceeds(getDocs(collection(adminDb(), 'announcements')));
});

test('enabled admins create valid drafts and schedules; direct publication and forged metadata fail', async () => {
  await assertSucceeds(setDoc(doc(adminDb(), 'announcements/draft'), row('draft')));
  await assertSucceeds(setDoc(doc(adminDb(), 'announcements/scheduled'), row()));
  await assertFails(setDoc(doc(userDb(), 'announcements/unauthorized'), row()));
  await assertFails(setDoc(doc(adminDb(), 'announcements/published'), row('published')));
  await assertFails(setDoc(doc(adminDb(), 'announcements/spoof'), { ...row(), createdBy: 'someone-else' }));
  await assertFails(setDoc(doc(adminDb(), 'announcements/extra'), { ...row(), unexpected: true }));
  await assertFails(setDoc(doc(adminDb(), 'announcements/time'), { ...row(), createdAt: Timestamp.fromMillis(1) }));
  await assertFails(setDoc(doc(adminDb(), 'announcements/url'), { ...row(), url: 'javascript:alert(1)' }));
  await assertFails(setDoc(doc(adminDb(), 'announcements/long'), { ...row(), title: 'a'.repeat(121) }));
});

test('admins edit pending rows but cannot rewrite published history or reschedule an archive', async () => {
  await seed('scheduled', 'scheduled'); await seed('published', 'published');
  await assertSucceeds(updateDoc(doc(adminDb(), 'announcements/scheduled'), { title: 'Edited', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(adminDb(), 'announcements/scheduled'), { status: 'published', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(adminDb(), 'announcements/published'), { title: 'Rewritten', updatedAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(adminDb(), 'announcements/published')));
  await assertSucceeds(updateDoc(doc(adminDb(), 'announcements/published'), { status: 'archived', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(adminDb(), 'announcements/published'), { status: 'scheduled', updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(publicDb(), 'announcements/published')));
});

test('devices can manage only their own valid registration; admin cannot list tokens and jobs are private', async () => {
  await assertSucceeds(setDoc(doc(userDb(), 'devices/device-user'), ownDevice()));
  await assertSucceeds(getDoc(doc(userDb(), 'devices/device-user')));
  const googleDeviceDb = env.authenticatedContext('device-user', { firebase: { sign_in_provider: 'google.com' } }).firestore();
  await assertFails(setDoc(doc(googleDeviceDb, 'devices/device-user'), ownDevice()));
  await assertFails(setDoc(doc(userDb(), 'devices/another-user'), ownDevice()));
  await assertFails(getDoc(doc(publicDb(), 'devices/device-user')));
  await assertFails(getDoc(doc(adminDb(), 'devices/device-user')));
  await assertFails(getDocs(collection(userDb(), 'devices')));
  await assertFails(getDocs(collection(adminDb(), 'devices')));
  await assertFails(updateDoc(doc(userDb(), 'devices/device-user'), { expoPushToken: 'not-a-token', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(userDb(), 'devices/device-user'), { updatedAt: Timestamp.fromMillis(1) }));
  await assertFails(setDoc(doc(adminDb(), 'notificationJobs/forged'), { status: 'pending' }));
  await assertFails(getDocs(collection(adminDb(), 'notificationReceipts')));
  await assertSucceeds(deleteDoc(doc(userDb(), 'devices/device-user')));
});

test('owner and super admin create admin and super admin accounts; only managers list accounts', async () => {
  for (const [uid, manager] of [['owner', ownerDb()], ['super', superDb()]]) {
    await assertSucceeds(getDocs(collection(manager, 'adminAccounts')));
    for (const role of ['admin', 'super_admin']) {
      const email = `${uid}-${role}@example.com`;
      await assertSucceeds(setDoc(doc(manager, 'adminAccounts', email), accountRow(email, { role, createdBy: uid })));
    }
    await assertFails(setDoc(doc(manager, 'adminAccounts', `${uid}-owner@example.com`), accountRow(`${uid}-owner@example.com`, { role: 'owner', createdBy: uid })));
  }
  const owner = ownerDb();
  const email = 'teacher@example.com';
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email)));
  await assertSucceeds(getDocs(collection(owner, 'adminAccounts')));
  await assertSucceeds(getDoc(doc(owner, 'adminAccounts', email)));
  await assertSucceeds(updateDoc(doc(owner, 'adminAccounts', email), { displayName: 'Teacher', enabled: false, updatedAt: serverTimestamp() }));
  for (const db of [publicDb(), userDb(), adminDb(), googleDb('manager-only', email, { accountManager: true })]) {
    await assertFails(getDocs(collection(db, 'adminAccounts')));
    await assertFails(setDoc(doc(db, 'adminAccounts/new@example.com'), accountRow('new@example.com')));
    await assertFails(updateDoc(doc(db, 'adminAccounts', email), { enabled: true, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'adminAccounts', email)));
  }
  await assertFails(getDoc(doc(adminDb(), 'adminAccounts', email)));
  await assertSucceeds(deleteDoc(doc(owner, 'adminAccounts', email)));
});

test('super admins modify and delete admins but only owners can modify or delete super admins', async () => {
  const manager = superDb();
  await assertSucceeds(updateDoc(doc(manager, 'adminAccounts/admin@example.com'), { enabled: false, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(manager, 'adminAccounts/admin@example.com')));
  await seedAccount('peer@example.com', { role: 'super_admin' });
  for (const patch of [{ enabled: false }, { displayName: 'Changed' }, { role: 'admin' }]) {
    await assertFails(updateDoc(doc(manager, 'adminAccounts/peer@example.com'), { ...patch, updatedAt: serverTimestamp() }));
  }
  await assertFails(deleteDoc(doc(manager, 'adminAccounts/peer@example.com')));
  await assertSucceeds(updateDoc(doc(ownerDb(), 'adminAccounts/peer@example.com'), { enabled: false, updatedAt: serverTimestamp() }));
  await assertSucceeds(deleteDoc(doc(ownerDb(), 'adminAccounts/peer@example.com')));
});

test('owner accounts cannot be changed or deleted by any client; role changes and self management fail', async () => {
  for (const manager of [ownerDb(), superDb(), adminDb()]) {
    await assertFails(deleteDoc(doc(manager, 'adminAccounts/owner@example.com')));
    for (const patch of [{ enabled: false }, { displayName: 'Changed' }, { role: 'admin' }]) {
      await assertFails(updateDoc(doc(manager, 'adminAccounts/owner@example.com'), { ...patch, updatedAt: serverTimestamp() }));
    }
    await assertFails(setDoc(doc(manager, 'adminAccounts/owner@example.com'), accountRow('owner@example.com')));
    await assertFails(updateDoc(doc(manager, 'adminAccounts/admin@example.com'), { role: 'super_admin', updatedAt: serverTimestamp() }));
  }
  for (const [uid, email, manager] of [['owner', 'owner@example.com', ownerDb()], ['super', 'super@example.com', superDb()]]) {
    await assertFails(updateDoc(doc(manager, 'adminAccounts', email), { enabled: false, updatedAt: serverTimestamp() }));
    await assertFails(deleteDoc(doc(manager, 'adminAccounts', email)));
    const missingSelf = googleDb(uid, `${uid}-missing@example.com`, uid === 'owner' ? { role: 'owner' } : {});
    await assertFails(setDoc(doc(missingSelf, 'adminAccounts', `${uid}-missing@example.com`), accountRow(`${uid}-missing@example.com`, { createdBy: uid })));
  }
});

test('invitation writes enforce normalized addresses, exact fields and immutable creation metadata', async () => {
  const owner = ownerDb();
  const email = 'teacher@example.com';
  const invalidRows = [
    accountRow('different@example.com'), accountRow(email, { displayName: 'x'.repeat(121) }),
    accountRow(email, { enabled: 'true' }), accountRow(email, { admin: true }),
    accountRow(email, { createdBy: 'another-owner' }),
    accountRow(email, { createdAt: Timestamp.fromMillis(1) }),
    accountRow(email, { updatedAt: Timestamp.fromMillis(1) }),
    accountRow(email, { role: null }), accountRow(email, { role: 'owner' }),
  ];
  for (const invalid of invalidRows) await assertFails(setDoc(doc(owner, 'adminAccounts', email), invalid));
  await assertFails(setDoc(doc(owner, 'adminAccounts/Teacher@example.com'), accountRow('Teacher@example.com')));
  for (const invalidEmail of ['no-domain', '.teacher@example.com', 'teacher.@example.com', 'teacher..name@example.com', 'teacher@-example.com', 'teacher@example-.com', 'teacher@localhost', '老師@example.com', `${'a'.repeat(243)}@example.com`]) {
    await assertFails(setDoc(doc(owner, 'adminAccounts', invalidEmail), accountRow(invalidEmail)));
  }
  const { role, ...missingRole } = accountRow(email);
  await assertFails(setDoc(doc(owner, 'adminAccounts', email), missingRole));
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email, { displayName: 'x'.repeat(120) })));
  for (const patch of [
    { email: 'different@example.com' }, { createdBy: 'another-owner' },
    { createdAt: Timestamp.fromMillis(1) }, { accountManager: true },
  ]) await assertFails(updateDoc(doc(owner, 'adminAccounts', email), { ...patch, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(owner, 'adminAccounts', email), { updatedAt: Timestamp.fromMillis(1) }));
  await assertSucceeds(updateDoc(doc(owner, 'adminAccounts', email), { displayName: '', enabled: false, updatedAt: serverTimestamp() }));
});

test('verified Google members can get only their own normalized invitation, including disabled or missing rows', async () => {
  const owner = ownerDb();
  const email = 'teacher@example.com';
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email, { enabled: false })));
  const member = googleDb('invited-admin', 'Teacher@Example.com');
  await assertSucceeds(getDoc(doc(member, 'adminAccounts', email)));
  await assertFails(getDoc(doc(member, 'adminAccounts/Teacher@Example.com')));
  await assertFails(getDoc(doc(member, 'adminAccounts/other@example.com')));
  await assertFails(getDocs(collection(member, 'adminAccounts')));
  await assertFails(getDocs(query(collection(member, 'adminAccounts'), where('email', '==', email))));
  await assertSucceeds(deleteDoc(doc(owner, 'adminAccounts', email)));
  await assertSucceeds(getDoc(doc(member, 'adminAccounts', email)));
  for (const db of [
    publicDb(), userDb(), googleDb('unverified', email, { email_verified: false }),
    googleDb('password', email, { firebase: { sign_in_provider: 'password' } }),
    env.authenticatedContext('no-email', { email_verified: true, firebase: { sign_in_provider: 'google.com' } }).firestore(),
  ]) await assertFails(getDoc(doc(db, 'adminAccounts', email)));
});

test('enabled Google invitations authorize announcement work without custom claims or membership escalation', async () => {
  const owner = ownerDb();
  const email = 'teacher@example.com';
  const member = googleDb('invited-admin', 'Teacher@Example.com');
  await seed('draft', 'draft'); await seed('published', 'published');
  await assertFails(getDoc(doc(member, 'announcements/draft')));
  await assertFails(setDoc(doc(member, 'announcements/new'), { ...row('draft'), createdBy: 'invited-admin' }));
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email)));
  await assertSucceeds(getDoc(doc(member, 'announcements/draft')));
  await assertSucceeds(getDocs(collection(member, 'announcements')));
  await assertSucceeds(setDoc(doc(member, 'announcements/new'), { ...row('draft'), createdBy: 'invited-admin' }));
  await assertSucceeds(updateDoc(doc(member, 'announcements/new'), { status: 'scheduled', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(member, 'announcements/new'), { status: 'published', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(member, 'announcements/published'), { title: 'Rewritten', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(member, 'announcements/published'), { status: 'archived', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(member, 'adminAccounts', email), { accountManager: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(member, 'adminAccounts', email), { enabled: true, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(member, 'adminAccounts/other@example.com'), accountRow('other@example.com', { createdBy: 'invited-admin' })));
  await assertFails(deleteDoc(doc(member, 'adminAccounts', email)));
  await assertFails(getDocs(collection(member, 'devices')));
  await assertFails(getDocs(collection(member, 'notificationJobs')));
});

test('invitation disable and deletion revoke access immediately with the same authenticated client', async () => {
  const owner = ownerDb();
  const email = 'teacher@example.com';
  const member = googleDb();
  await seed('draft', 'draft'); await seed('published', 'published');
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email)));
  await assertSucceeds(getDoc(doc(member, 'announcements/draft')));
  await assertSucceeds(updateDoc(doc(owner, 'adminAccounts', email), { enabled: false, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(member, 'announcements/draft')));
  await assertFails(getDocs(collection(member, 'announcements')));
  await assertFails(updateDoc(doc(member, 'announcements/draft'), { title: 'Denied', updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(member, 'adminAccounts', email)));
  await assertSucceeds(getDoc(doc(member, 'announcements/published')));
  await assertSucceeds(updateDoc(doc(owner, 'adminAccounts', email), { enabled: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(member, 'announcements/draft')));
  await assertSucceeds(deleteDoc(doc(owner, 'adminAccounts', email)));
  await assertFails(getDoc(doc(member, 'announcements/draft')));
  await assertFails(setDoc(doc(member, 'announcements/new'), { ...row('draft'), createdBy: 'invited-admin' }));
});

test('unverified or non-Google invitations confer no admin rights; invitation cannot supply a missing owner claim', async () => {
  const owner = ownerDb();
  const email = 'teacher@example.com';
  await assertSucceeds(setDoc(doc(owner, 'adminAccounts', email), accountRow(email)));
  await seed('draft', 'draft');
  for (const db of [
    googleDb('unverified', email, { email_verified: false }),
    googleDb('password', email, { firebase: { sign_in_provider: 'password' } }),
    googleDb('anonymous', email, { firebase: { sign_in_provider: 'anonymous' } }),
  ]) {
    await assertFails(getDoc(doc(db, 'announcements/draft')));
    await assertFails(setDoc(doc(db, 'announcements/new'), { ...row('draft'), createdBy: 'invited-admin' }));
  }
  const invitedManager = googleDb('manager-only', email, { accountManager: true });
  await assertSucceeds(getDoc(doc(invitedManager, 'announcements/draft')));
  await assertFails(getDocs(collection(invitedManager, 'adminAccounts')));
  await assertFails(updateDoc(doc(invitedManager, 'adminAccounts', email), { displayName: 'Escalated', updatedAt: serverTimestamp() }));
});

test('rooted owner claims remain independent; stale admin and super claims cannot bypass membership revocation', async () => {
  await seed('draft', 'draft');
  await seedAccount('owner@example.com', { role: 'owner', enabled: false });
  for (const claims of [{ role: 'owner' }, { admin: true, accountManager: true }]) {
    const owner = googleDb('owner', 'owner@example.com', claims);
    await assertSucceeds(getDoc(doc(owner, 'announcements/draft')));
    await assertSucceeds(getDocs(collection(owner, 'adminAccounts')));
    await assertFails(deleteDoc(doc(owner, 'adminAccounts/owner@example.com')));
  }
  for (const claims of [{ admin: true }, { role: 'admin' }, { role: 'super_admin' }, { admin: 'true', accountManager: true }]) {
    const stale = googleDb('stale', 'stale@example.com', claims);
    await assertFails(getDoc(doc(stale, 'announcements/draft')));
    await assertFails(getDocs(collection(stale, 'adminAccounts')));
  }
  const stale = googleDb('admin', 'admin@example.com', { admin: true });
  await assertSucceeds(getDoc(doc(stale, 'announcements/draft')));
  await assertSucceeds(deleteDoc(doc(ownerDb(), 'adminAccounts/admin@example.com')));
  await assertFails(getDoc(doc(stale, 'announcements/draft')));
});

test('legacy invitations remain announcement admins and cannot be promoted through client updates', async () => {
  const email = 'legacy@example.com';
  const { role, ...legacy } = accountRow(email);
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'adminAccounts', email), legacy);
  });
  const member = googleDb('legacy', email);
  await seed('draft', 'draft');
  await assertSucceeds(getDoc(doc(member, 'announcements/draft')));
  await assertFails(getDocs(collection(member, 'adminAccounts')));
  await assertSucceeds(updateDoc(doc(superDb(), 'adminAccounts', email), { displayName: 'Legacy', updatedAt: serverTimestamp() }));
  for (const manager of [ownerDb(), superDb()]) {
    await assertFails(updateDoc(doc(manager, 'adminAccounts', email), { role: 'super_admin', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(manager, 'adminAccounts', email), { role: 'admin', updatedAt: serverTimestamp() }));
  }
  await assertSucceeds(deleteDoc(doc(superDb(), 'adminAccounts', email)));
  await assertFails(getDoc(doc(member, 'announcements/draft')));
});

test('membership owner roles never grant access and disabled or deleted super admins lose manager access', async () => {
  await seed('draft', 'draft');
  await seedAccount('forged-owner@example.com', { role: 'owner' });
  const forged = googleDb('forged-owner', 'forged-owner@example.com');
  await assertSucceeds(getDoc(doc(forged, 'adminAccounts/forged-owner@example.com')));
  await assertFails(getDoc(doc(forged, 'announcements/draft')));
  await assertFails(getDocs(collection(forged, 'adminAccounts')));
  const manager = superDb();
  await assertSucceeds(getDoc(doc(manager, 'announcements/draft')));
  await assertSucceeds(getDocs(collection(manager, 'adminAccounts')));
  await assertSucceeds(updateDoc(doc(ownerDb(), 'adminAccounts/super@example.com'), { enabled: false, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(manager, 'announcements/draft')));
  await assertFails(getDocs(collection(manager, 'adminAccounts')));
  await assertFails(setDoc(doc(manager, 'adminAccounts/denied@example.com'), accountRow('denied@example.com', { createdBy: 'super' })));
  await assertSucceeds(updateDoc(doc(ownerDb(), 'adminAccounts/super@example.com'), { enabled: true, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDocs(collection(manager, 'adminAccounts')));
  await assertSucceeds(deleteDoc(doc(ownerDb(), 'adminAccounts/super@example.com')));
  await assertFails(getDoc(doc(manager, 'announcements/draft')));
  await assertFails(getDocs(collection(manager, 'adminAccounts')));
});
