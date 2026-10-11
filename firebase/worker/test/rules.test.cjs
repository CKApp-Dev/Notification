const { test, before, beforeEach, after } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { assertFails, assertSucceeds, initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, collection, query, where, orderBy, limit, updateDoc, deleteDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
let env;
const row = (status = 'scheduled') => ({ title: 'New announcement', body: 'News for students', url: 'https://school.example/news', status,
  publishAt: Timestamp.fromMillis(Date.now() - 10000), publishedAt: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: 'admin' });
const ownDevice = () => ({ expoPushToken: 'ExpoPushToken[test-token]', platform: 'ios', enabled: true, updatedAt: serverTimestamp() });
const adminDb = () => env.authenticatedContext('admin', { admin: true }).firestore();
const userDb = () => env.authenticatedContext('device-user', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
const publicDb = () => env.unauthenticatedContext().firestore();

before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-ck-announcements', firestore: { rules: readFileSync(resolve(__dirname, '../../firestore.rules'), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env.cleanup(); });
async function seed(id, status) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), 'announcements', id), { ...row(status), createdAt: Timestamp.now(), updatedAt: Timestamp.now(), publishedAt: status === 'published' ? Timestamp.now() : null });
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

test('only claimed admins create valid drafts and schedules; direct publication and forged metadata fail', async () => {
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
