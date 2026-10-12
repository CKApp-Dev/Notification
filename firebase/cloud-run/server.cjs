'use strict';

const { createServer } = require('node:http');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { Expo } = require('expo-server-sdk');
const { runNotificationWorker } = require('./lib/run');
const { createHandler } = require('./adapter.cjs');
const { createAuthorizer } = require('./auth.cjs');

if (process.env.GOOGLE_CLOUD_PROJECT !== 'ck-app-database') {
  console.error('Set GOOGLE_CLOUD_PROJECT to ck-app-database.');
  process.exit(1);
}

const app = initializeApp({ projectId: 'ck-app-database' });
const db = getFirestore(app);
const auth = getAuth(app);
const gateway = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN || undefined, maxConcurrentRequests: 2 });
const authorize = createAuthorizer({
  verifyIdToken: token => auth.verifyIdToken(token),
  readAdminAccount: async email => (await db.collection('adminAccounts').doc(email).get()).data(),
});
const server = createServer(createHandler(() => runNotificationWorker(db, gateway), {
  authorize,
  ...(process.env.MANUAL_PUBLISH_ORIGIN ? { allowedOrigin: process.env.MANUAL_PUBLISH_ORIGIN } : {}),
}));
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');

process.on('SIGTERM', () => {
  server.close(() => {
    db.terminate().then(() => process.exit(0), () => process.exit(1));
  });
});
